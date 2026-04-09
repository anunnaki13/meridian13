/**
 * Study top LPers for a pool and extract behavioural patterns.
 *
 * Two modes:
 *   1. On-chain (default, free) — reads position accounts directly via Meteora SDK
 *   2. LPAgent API (fallback if LPAGENT_API_KEY set) — richer historical data
 *
 * The on-chain approach reverse-engineers top LPer strategies from live position data:
 *   - Reads all positions in a pool via getLbPairLockInfo()
 *   - Ranks by TVL to find the biggest LPers
 *   - Fetches full position details (bin range, fees, liquidity distribution)
 *   - Analyzes strategy patterns (range width, concentration, bid_ask vs spot)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";

// ─── Lazy SDK loader (shared with dlmm.js pattern) ──────────────
let _DLMM = null;
async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

function getConnection() {
  return new Connection(process.env.RPC_URL, "confirmed");
}

// ─── On-Chain Study (Primary — Free) ─────────────────────────────

/**
 * Study top LPers by reading on-chain position data directly.
 * No API key required — only RPC calls.
 */
async function studyOnChain(poolAddress, limit = 5) {
  const DLMM = await getDLMM();
  const connection = getConnection();
  const poolPubkey = new PublicKey(poolAddress);

  log("study", `On-chain study: fetching all positions for pool ${poolAddress.slice(0, 8)}...`);

  const pool = await DLMM.create(connection, poolPubkey);
  const activeBin = await pool.getActiveBin();
  const activeBinId = activeBin.binId;
  const binStep = pool.lbPair.binStep;

  // Fetch ALL positions in this pool (all owners)
  const lockInfo = await pool.getLbPairLockInfo();
  const allPositions = lockInfo?.positions || [];

  if (allPositions.length === 0) {
    return {
      pool: poolAddress,
      method: "on-chain",
      message: "No positions found in this pool.",
      total_positions: 0,
      patterns: null,
      lpers: [],
    };
  }

  log("study", `Found ${allPositions.length} positions in pool`);

  // Parse token amounts and rank by TVL
  const ranked = allPositions
    .map((p) => {
      const xAmount = parseFloat(p.tokenXAmount || "0");
      const yAmount = parseFloat(p.tokenYAmount || "0");
      return {
        positionAddress: p.positionAddress,
        owner: p.owner?.toString() || "unknown",
        tokenX: xAmount,
        tokenY: yAmount,
        // Use Y amount (SOL) as primary ranking since it's the quote token
        totalValue: yAmount + xAmount * 0.001, // rough proxy — Y (SOL) dominates
      };
    })
    .sort((a, b) => b.totalValue - a.totalValue);

  // Take top positions for detailed analysis
  const topCount = Math.min(limit * 3, 15, ranked.length); // fetch more, dedup by owner later
  const topPositionAddrs = ranked.slice(0, topCount);

  // Fetch full position details for top positions
  const detailedPositions = [];
  const fetchBatch = topPositionAddrs.map(async (p) => {
    try {
      const pos = await pool.getPosition(p.positionAddress);
      return { ...p, detail: pos };
    } catch (e) {
      log("study_warn", `Failed to fetch position ${p.positionAddress.toString().slice(0, 8)}: ${e.message}`);
      return { ...p, detail: null };
    }
  });

  const results = await Promise.allSettled(fetchBatch);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.detail) {
      detailedPositions.push(r.value);
    }
  }

  // Group by owner
  const ownerMap = new Map();
  for (const p of detailedPositions) {
    const owner = p.owner;
    if (!ownerMap.has(owner)) ownerMap.set(owner, []);
    ownerMap.get(owner).push(p);
  }

  // Analyze each owner's strategy
  const lperAnalysis = [];
  for (const [owner, positions] of ownerMap) {
    const analysis = analyzeOwnerPositions(positions, activeBinId, binStep);
    lperAnalysis.push({
      owner_short: owner.slice(0, 8) + "..." + owner.slice(-4),
      owner,
      ...analysis,
    });
  }

  // Sort by total SOL deployed
  lperAnalysis.sort((a, b) => b.total_sol - a.total_sol);
  const topLpers = lperAnalysis.slice(0, limit);

  // Aggregate patterns across top LPers
  const patterns = aggregatePatterns(topLpers, activeBinId, binStep);

  return {
    pool: poolAddress,
    method: "on-chain",
    active_bin: activeBinId,
    bin_step: binStep,
    total_positions_in_pool: allPositions.length,
    top_lper_count: topLpers.length,
    patterns,
    lpers: topLpers,
  };
}

/**
 * Analyze a single owner's positions to extract strategy patterns.
 */
function analyzeOwnerPositions(positions, activeBinId, binStep) {
  const posDetails = [];
  let totalSol = 0;
  let totalTokenX = 0;
  let totalFeeX = 0;
  let totalFeeY = 0;

  for (const p of positions) {
    const pd = p.detail?.positionData;
    if (!pd) continue;

    const lowerBin = pd.lowerBinId;
    const upperBin = pd.upperBinId;
    const totalBins = upperBin - lowerBin + 1;
    const binsBelow = activeBinId - lowerBin;
    const binsAbove = upperBin - activeBinId;

    // Determine if position is in range
    const inRange = activeBinId >= lowerBin && activeBinId <= upperBin;

    // Determine strategy type from liquidity distribution
    const binData = pd.positionBinData || [];
    const strategy = inferStrategy(binData, activeBinId);

    // Calculate concentration — how tightly liquidity is clustered
    const concentration = calcConcentration(binData);

    const yAmount = parseFloat(pd.totalYAmount || "0") / 1e9; // SOL has 9 decimals
    const xAmount = parseFloat(pd.totalXAmount || "0");
    const feeX = pd.feeX ? parseFloat(pd.feeX.toString()) : 0;
    const feeY = pd.feeY ? parseFloat(pd.feeY.toString()) / 1e9 : 0;

    totalSol += yAmount;
    totalTokenX += xAmount;
    totalFeeX += feeX;
    totalFeeY += feeY;

    posDetails.push({
      position: p.positionAddress.toString().slice(0, 8) + "...",
      lower_bin: lowerBin,
      upper_bin: upperBin,
      total_bins: totalBins,
      bins_below: Math.max(0, binsBelow),
      bins_above: Math.max(0, binsAbove),
      in_range: inRange,
      strategy,
      concentration,
      sol_amount: round(yAmount, 4),
      unclaimed_fee_sol: round(feeY, 6),
    });
  }

  // Aggregate strategy across positions
  const strategies = posDetails.map((p) => p.strategy);
  const dominantStrategy = mode(strategies) || "unknown";
  const avgBins = avg(posDetails.map((p) => p.total_bins));
  const avgBinsBelow = avg(posDetails.map((p) => p.bins_below));
  const avgBinsAbove = avg(posDetails.map((p) => p.bins_above));
  const inRangePct = posDetails.filter((p) => p.in_range).length / posDetails.length * 100;

  return {
    position_count: posDetails.length,
    total_sol: round(totalSol, 4),
    unclaimed_fees_sol: round(totalFeeY, 6),
    dominant_strategy: dominantStrategy,
    avg_total_bins: Math.round(avgBins),
    avg_bins_below: Math.round(avgBinsBelow),
    avg_bins_above: Math.round(avgBinsAbove),
    in_range_pct: Math.round(inRangePct),
    positions: posDetails,
  };
}

/**
 * Infer the strategy type from liquidity distribution across bins.
 *
 * - bid_ask: liquidity concentrated at edges (near active bin), thin in middle
 * - spot: roughly uniform distribution
 * - curve: bell-curve shape, concentrated around active bin
 */
function inferStrategy(binData, activeBinId) {
  if (!binData || binData.length < 3) return "unknown";

  const liquidities = binData.map((b) => {
    const liq = parseFloat(b.positionLiquidity || b.binLiquidity || "0");
    return { binId: b.binId, liq };
  }).filter((b) => b.liq > 0);

  if (liquidities.length === 0) return "empty";

  const totalLiq = liquidities.reduce((s, b) => s + b.liq, 0);
  if (totalLiq === 0) return "empty";

  // Check if single-sided (all below or all above active bin)
  const belowCount = liquidities.filter((b) => b.binId < activeBinId).length;
  const aboveCount = liquidities.filter((b) => b.binId > activeBinId).length;

  if (belowCount > 0 && aboveCount === 0) return "bid_ask";  // single-sided below
  if (aboveCount > 0 && belowCount === 0) return "ask_only"; // single-sided above

  // Check distribution shape
  // Split bins into thirds: lower, middle, upper
  const sorted = [...liquidities].sort((a, b) => a.binId - b.binId);
  const third = Math.ceil(sorted.length / 3);
  const lowerThird = sorted.slice(0, third).reduce((s, b) => s + b.liq, 0);
  const middleThird = sorted.slice(third, third * 2).reduce((s, b) => s + b.liq, 0);
  const upperThird = sorted.slice(third * 2).reduce((s, b) => s + b.liq, 0);

  // Curve: middle heavy
  if (middleThird > lowerThird * 1.5 && middleThird > upperThird * 1.5) return "curve";

  // Bid-ask: edges heavy
  if ((lowerThird + upperThird) > middleThird * 2) return "bid_ask";

  // Default: spot (roughly uniform)
  return "spot";
}

/**
 * Calculate how concentrated the liquidity is (0-100).
 * 100 = all liquidity in one bin, 0 = perfectly uniform.
 */
function calcConcentration(binData) {
  if (!binData || binData.length === 0) return 0;

  const liquidities = binData.map((b) => parseFloat(b.positionLiquidity || "0"));
  const total = liquidities.reduce((s, l) => s + l, 0);
  if (total === 0) return 0;

  // Herfindahl index (sum of squared shares)
  const hhi = liquidities.reduce((s, l) => s + Math.pow(l / total, 2), 0);
  // Normalize: 1/N (uniform) to 1 (single bin)
  const n = liquidities.length;
  const minHhi = 1 / n;
  return Math.round(((hhi - minHhi) / (1 - minHhi)) * 100);
}

/**
 * Aggregate patterns across all top LPers.
 */
function aggregatePatterns(lpers, activeBinId, binStep) {
  if (lpers.length === 0) return null;

  const allBinsBelow = lpers.map((l) => l.avg_bins_below).filter(isNum);
  const allBinsAbove = lpers.map((l) => l.avg_bins_above).filter(isNum);
  const allTotalBins = lpers.map((l) => l.avg_total_bins).filter(isNum);
  const strategies = lpers.map((l) => l.dominant_strategy);

  // What's the consensus range?
  const consensusBinsBelow = Math.round(avg(allBinsBelow));
  const consensusBinsAbove = Math.round(avg(allBinsAbove));
  const consensusTotalBins = Math.round(avg(allTotalBins));
  const consensusStrategy = mode(strategies) || "bid_ask";

  // Range width in % price terms (approximate)
  // Each bin step represents (binStep / 10000) price change
  const rangePctBelow = round(consensusBinsBelow * binStep / 100, 1);
  const rangePctAbove = round(consensusBinsAbove * binStep / 100, 1);

  // How many have bins above? (dual-sided vs single-sided)
  const dualSidedCount = lpers.filter((l) => l.avg_bins_above > 2).length;
  const singleSidedCount = lpers.length - dualSidedCount;

  // In-range percentage
  const avgInRange = avg(lpers.map((l) => l.in_range_pct).filter(isNum));

  return {
    top_lper_count: lpers.length,
    total_sol_deployed: round(lpers.reduce((s, l) => s + l.total_sol, 0), 2),
    consensus_strategy: consensusStrategy,
    consensus_bins_below: consensusBinsBelow,
    consensus_bins_above: consensusBinsAbove,
    consensus_total_bins: consensusTotalBins,
    range_pct_below: rangePctBelow + "%",
    range_pct_above: rangePctAbove + "%",
    dual_sided_count: dualSidedCount,
    single_sided_count: singleSidedCount,
    avg_in_range_pct: Math.round(avgInRange),
    recommendation: buildRecommendation({
      consensusBinsBelow,
      consensusBinsAbove,
      consensusStrategy,
      dualSidedCount,
      singleSidedCount,
      avgInRange,
    }),
  };
}

function buildRecommendation({ consensusBinsBelow, consensusBinsAbove, consensusStrategy, dualSidedCount, singleSidedCount, avgInRange }) {
  const parts = [];

  if (dualSidedCount > singleSidedCount) {
    parts.push(`Top LPers favor dual-sided positions (${dualSidedCount} dual vs ${singleSidedCount} single-sided).`);
  } else {
    parts.push(`Top LPers favor single-sided below positions (${singleSidedCount} single vs ${dualSidedCount} dual-sided).`);
  }

  parts.push(`Consensus range: ${consensusBinsBelow} bins below, ${consensusBinsAbove} bins above (${consensusBinsBelow + consensusBinsAbove} total).`);
  parts.push(`Dominant strategy: ${consensusStrategy}.`);

  if (avgInRange < 50) {
    parts.push("WARNING: Most top LPers are currently out of range — pool may be in a strong trend.");
  } else if (avgInRange > 80) {
    parts.push("Most positions are in range — good sign for fee capture.");
  }

  return parts.join(" ");
}

// ─── LPAgent API Study (Fallback) ────────────────────────────────

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const LPAGENT_KEYS = (process.env.LPAGENT_API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
let _keyIndex = 0;
function nextKey() {
  if (!LPAGENT_KEYS.length) return null;
  const key = LPAGENT_KEYS[_keyIndex % LPAGENT_KEYS.length];
  _keyIndex++;
  return key;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function studyViaApi(poolAddress, limit = 4) {
  const topRes = await fetch(
    `${LPAGENT_API}/pools/${poolAddress}/top-lpers?sort_order=desc&page=1&limit=20`,
    { headers: { "x-api-key": nextKey() } }
  );

  if (!topRes.ok) {
    if (topRes.status === 429) {
      throw new Error(`Rate limit exceeded. Please wait 60 seconds before studying this pool again.`);
    }
    throw new Error(`top-lpers API error: ${topRes.status}`);
  }

  const topData = await topRes.json();
  const all = topData.data || [];

  const credible = all.filter(
    (l) => l.total_lp >= 3 && l.win_rate >= 0.6 && l.total_inflow > 1000
  );

  const top = credible
    .sort((a, b) => b.roi - a.roi)
    .slice(0, limit);

  if (top.length === 0) {
    return {
      pool: poolAddress,
      method: "api",
      message: "No credible LPers found (need ≥3 positions, ≥60% win rate, ≥$1k inflow).",
      patterns: null,
      lpers: [],
    };
  }

  const historicalSamples = [];
  for (const lper of top) {
    const sample = {
      owner: lper.owner,
      owner_short: lper.owner.slice(0, 8) + "...",
      summary: {
        total_positions: lper.total_lp,
        win_rate: Math.round(lper.win_rate * 100) + "%",
        avg_hold_hours: Number(lper.avg_age_hour?.toFixed(2)),
        roi: (lper.roi * 100).toFixed(2) + "%",
        fee_pct_of_capital: (lper.fee_percent * 100).toFixed(2) + "%",
        total_pnl_usd: Math.round(lper.total_pnl),
      },
      positions: [],
    };

    try {
      await sleep(1000);
      const histRes = await fetch(
        `${LPAGENT_API}/lp-positions/historical?owner=${lper.owner}&page=1&limit=50`,
        { headers: { "x-api-key": nextKey() } }
      );

      if (histRes.ok) {
        const histData = await histRes.json();
        sample.positions = (histData.data || []).map((p) => ({
          pool: p.pool,
          pair: p.pairName || `${p.tokenName0}-${p.tokenName1}`,
          hold_hours: p.ageHour != null ? Number(p.ageHour?.toFixed(2)) : null,
          pnl_usd: Math.round(p.pnl?.value || 0),
          pnl_pct: ((p.pnl?.percent || 0) * 100).toFixed(1) + "%",
          fee_usd: Math.round(p.collectedFee || 0),
          in_range_pct: p.inRangePct != null ? Math.round(p.inRangePct * 100) + "%" : null,
          strategy: p.strategy || null,
        }));
      }
    } catch { /* ignore */ }
    historicalSamples.push(sample);
  }

  const patterns = {
    top_lper_count: top.length,
    avg_hold_hours: avg(top.map((l) => l.avg_age_hour).filter(isNum)),
    avg_win_rate: avg(top.map((l) => l.win_rate).filter(isNum)),
    avg_roi_pct: avg(top.map((l) => l.roi * 100).filter(isNum)),
    avg_fee_pct_of_capital: avg(top.map((l) => l.fee_percent * 100).filter(isNum)),
    best_roi: (Math.max(...top.map((l) => l.roi)) * 100).toFixed(2) + "%",
    scalper_count: top.filter((l) => l.avg_age_hour < 1).length,
    holder_count: top.filter((l) => l.avg_age_hour >= 4).length,
  };

  return {
    pool: poolAddress,
    method: "api",
    patterns,
    lpers: historicalSamples,
  };
}

// ─── Public Entry Point ──────────────────────────────────────────

/**
 * Study top LPers for a pool.
 * Uses on-chain analysis by default (free). Falls back to LPAgent API if key is set.
 */
export async function studyTopLPers({ pool_address, limit = 5, method = "auto" }) {
  // Auto: prefer on-chain (free), use API only if explicitly requested or on-chain fails
  if (method === "api" && LPAGENT_KEYS.length > 0) {
    return studyViaApi(pool_address, limit);
  }

  if (method === "auto" || method === "onchain") {
    try {
      return await studyOnChain(pool_address, limit);
    } catch (e) {
      log("study_warn", `On-chain study failed: ${e.message}`);
      // Fall back to API if available
      if (LPAGENT_KEYS.length > 0) {
        log("study", "Falling back to LPAgent API");
        return studyViaApi(pool_address, limit);
      }
      return {
        pool: pool_address,
        error: `On-chain study failed: ${e.message}. Set LPAGENT_API_KEY for API fallback.`,
        patterns: null,
        lpers: [],
      };
    }
  }

  return { error: `Unknown method: ${method}. Use "auto", "onchain", or "api".` };
}

// ─── Helpers ─────────────────────────────────────────────────────

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function round(n, decimals) {
  if (!isNum(n)) return 0;
  return Number(n.toFixed(decimals));
}

function isNum(n) {
  return typeof n === "number" && isFinite(n);
}

function mode(arr) {
  if (!arr.length) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
}
