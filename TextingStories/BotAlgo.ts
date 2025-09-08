/**
 * run-detect.ts
 * Interactive runner for detectBotAlgo
 */

// @ts-ignore
import { stdin as input, stdout as output } from "process";
// @ts-ignore
import process from "process";
// @ts-ignore
import { createInterface } from "readline";
// @ts-ignore
import { readFile as fsReadFile } from "fs/promises";

export interface ScanData {
  views: number;
  likes: number;
  saves: number;
  shares: number;
  comments: number;
  missing?: boolean;
}

export interface BotDetectorAlgoResponse {
  shouldReject: boolean;
  bottedReason: string;
}

export interface Props {
  prevScan: ScanData;
  currentScan: ScanData;
  platform: string;
  scanIndex?: number;
  allScans?: ScanData[];
  logNotes?: boolean;
}

// Add this helper near the top:
function inferPlatformFromUrl(dumpUrl: string): string {
  try {
    const post = new URL(dumpUrl).searchParams.get("postUrl") || "";
    const host = new URL(post).hostname.toLowerCase();
    if (host.includes("snapchat")) return "snapchat";
    if (host.includes("tiktok")) return "tiktok";
    if (host.includes("instagram")) return "instagram";
    if (host.includes("youtube") || host.includes("youtu.be")) return "youtube";
    return "unknown";
  } catch { return "unknown"; }
}

// ---- Your algo (cleaner version from bot-detector-algorithm.ts) ----
export function detectBotAlgo({ prevScan, currentScan, platform, scanIndex, allScans, logNotes }: Props): BotDetectorAlgoResponse {
  const { views: scanViews, likes: scanLikes, saves: scanSaves, shares: scanShares, comments: scanComments } = currentScan;
  const { views: prevViews, likes: prevLikes, saves: prevSaves, shares: prevShares, comments: prevComments } = prevScan;
  
  const commentRatio = (scanComments / scanViews) * 100;
  let shouldReject = false;
  let bottedReason = '';

  // Helper function for anomaly detection
  const checkAnomaly = (metric: string, current: number, previous: number, viewGrowth: number, threshold: number) => {
    // Handle zero-to-something jumps first
    if (previous === 0 && current >= 10 && scanViews < prevViews * viewGrowth) {
      bottedReason += `\n${metric} appeared (0→${current}) without corresponding jump in views`;
      shouldReject = true;
      return;
    }
    if (previous > 0 && scanViews < prevViews * viewGrowth && current > previous * threshold) {
      bottedReason += `\n${metric} grew quickly without corresponding jump in views`;
      shouldReject = true;
    }
  };

  // ---- Single-scan glitch guard + bridging ----
  const isNumber = (v: any) => typeof v === 'number' && Number.isFinite(v);
  const toNum = (v: any) => (isNumber(v) ? (v as number) : 0);
  const isZeroish = (v: any) => !isNumber(v) || v === 0;

  // A boundary is affected by a glitch when one side is 0/undefined for exactly one scan
  // We only BRIDGE when the CURRENT scan (index=scanIndex) is the zero/undefined hub.
  const hasNext = allScans && typeof scanIndex === 'number' && (scanIndex + 1) < (allScans?.length || 0);
  const hasPrevPrev = allScans && typeof scanIndex === 'number' && (scanIndex - 2) >= 0;
  const nextScan = hasNext ? (allScans as any)[scanIndex + 1] : undefined;
  const prevPrevScan = hasPrevPrev ? (allScans as any)[scanIndex - 2] : undefined;

  const glitchLikes = (isZeroish(scanLikes) && !!nextScan && prevLikes > 0 && toNum(nextScan?.likes) > 0)
                   || (isZeroish(prevLikes) && !!prevPrevScan && toNum(prevPrevScan?.likes) > 0 && scanLikes > 0);
  const glitchComments = (isZeroish(scanComments) && !!nextScan && prevComments > 0 && toNum(nextScan?.comments) > 0)
                      || (isZeroish(prevComments) && !!prevPrevScan && toNum(prevPrevScan?.comments) > 0 && scanComments > 0);
  const glitchSaves = (isZeroish(scanSaves) && !!nextScan && prevSaves > 0 && toNum(nextScan?.saves) > 0)
                   || (isZeroish(prevSaves) && !!prevPrevScan && toNum(prevPrevScan?.saves) > 0 && scanSaves > 0);
  const glitchShares = (isZeroish(scanShares) && !!nextScan && prevShares > 0 && toNum(nextScan?.shares) > 0)
                    || (isZeroish(prevShares) && !!prevPrevScan && toNum(prevPrevScan?.shares) > 0 && scanShares > 0);

  type MetricKey = 'likes' | 'comments' | 'saves' | 'shares';
  const getEffectivePair = (key: MetricKey) => {
    // Default: use the current boundary prev→curr
    let pVal = toNum((prevScan as any)[key]);
    let cVal = toNum((currentScan as any)[key]);
    let pViews = prevViews;
    let cViews = scanViews;
    let bridged = false;
    if (hasNext && isZeroish((currentScan as any)[key]) && toNum((prevScan as any)[key]) > 0 && toNum(nextScan?.[key]) > 0) {
      // Bridge over the middle scan (current)
      cVal = toNum(nextScan?.[key]);
      cViews = toNum(nextScan?.views);
      bridged = true;
    }
    return { prev: pVal, curr: cVal, prevViews: pViews, currViews: cViews, bridged };
  };

  // Run sharp-change anomaly rules on every scan after the first
  const matureScan = typeof scanIndex === 'number' && scanIndex >= 1;

  // LIKES ANOMALIES (exclude YouTube and Snapchat - Snapchat likes unavailable)
  if (platform !== 'youtube' && platform !== 'snapchat') {
    const L = getEffectivePair('likes');
    if (L.currViews > 1000 && L.currViews > L.prevViews * 2 && L.curr < L.prev * 1.2) {
      bottedReason += '\nviews doubled quickly without corresponding jump in likes';
      shouldReject = true;
    }

    // Views jumped by 500+ but likes changed by <2
    if (matureScan && !glitchLikes && (L.currViews - L.prevViews) >= 1000 && (L.curr - L.prev) < 2) {
      bottedReason += '\nviews grew but <2 likes change';
      shouldReject = true;
    }

    // Additional anomalies
    if (matureScan && !glitchLikes && L.curr > 0 && L.curr > L.prev * 1.5 && L.currViews < L.prevViews * 1.2) {
      bottedReason += '\nlikes spiked (≥1.5x) without corresponding jump in views';
      shouldReject = true;
    }
  }

  // Check shares and saves anomalies (apply to all platforms)
  if (matureScan) {
    if (!glitchShares) {
      const S = getEffectivePair('shares');
      checkAnomaly('shares', S.curr, S.prev, 2, 10);
      checkAnomaly('shares', S.curr, S.prev, 1.2, 3);
    }
    if (!glitchSaves) {
      const SV = getEffectivePair('saves');
      checkAnomaly('saves', SV.curr, SV.prev, 2, 10);
      checkAnomaly('saves', SV.curr, SV.prev, 1.2, 3);
    }
  }

  // SHARES ANOMALY RULE (moved outside YouTube exclusion)
  if (matureScan && !glitchShares) {
    const S0 = getEffectivePair('shares');
    if (prevShares === 0 && !S0.bridged && scanShares >= 10 && scanViews < prevViews * 2) {
      bottedReason += '\nshares appeared (0→X) without corresponding jump in views';
      shouldReject = true;
    }
  }

  // SAVES ANOMALY RULE (handle 0→X jumps explicitly)
  if (matureScan && !glitchSaves) {
    const SV0 = getEffectivePair('saves');
    if (prevSaves === 0 && !SV0.bridged && scanSaves >= 10 && scanViews < prevViews * 2) {
      bottedReason += '\nsaves appeared (0→X) without corresponding jump in views';
      shouldReject = true;
    }
  }

  // ZERO LIKES RULE
  if (matureScan && !glitchLikes) {
    const L0 = getEffectivePair('likes');
    if (L0.currViews > 1000 && L0.curr === 0 && ['tiktok', 'instagram', 'youtube'].includes(platform)) {
      bottedReason += '\nzero likes';
      shouldReject = true;
    }
  }

  // SNAPCHAT ULTRA-LOW ENGAGEMENT RULE
  if (platform === 'snapchat' && scanViews > 20000 && scanComments === 0 && scanShares <= 1) {
    // Don't add detailed message here - it will be summarized later
    shouldReject = true;
  }

  // ZERO COMMENTS & LOW RATIO (log but don't reject - too many false positives)
  if (logNotes && scanViews > 5000) {
    if (scanComments === 0) {
      // Don't add detailed message here - it will be summarized later
      console.log(`    📝 NOTE: Zero comments with ${scanViews} views (not rejecting)`);
    }
    if (commentRatio < 0.01) {
      // Don't add detailed message here - it will be summarized later
      console.log(`    📝 NOTE: Low comment ratio ${commentRatio.toFixed(4)}% with ${scanViews} views (not rejecting)`);
    }
  }

  // LIKE-RATIO COLLAPSE AFTER MAJOR VIEW JUMP (exclude YouTube and Snapchat - likes unavailable/lag)
  // Additional guard: only evaluate from scanIndex > 3 to reduce early noise
  if (platform !== 'youtube' && platform !== 'snapchat' && prevViews >= 100 && matureScan) {
    const Lr = getEffectivePair('likes');
    const prevLikeRatio = Lr.prevViews > 0 ? Lr.prev / Lr.prevViews : 0;
    const currLikeRatio = Lr.currViews > 0 ? Lr.curr / Lr.currViews : 0;
    const bigJump = (Lr.currViews >= Lr.prevViews * 5) || (Lr.currViews - Lr.prevViews >= 5000);

    if (!glitchLikes && bigJump && prevLikeRatio > 0) {
      const dropFactor = prevLikeRatio / Math.max(currLikeRatio, 1e-9);
      if (dropFactor >= 3) {
        bottedReason += `\nmassive view jump with like-ratio collapse (${(prevLikeRatio * 100).toFixed(2)}% → ${(currLikeRatio * 100).toFixed(2)}%)`;
        shouldReject = true;
      }
    }
  }

  // MASSIVE COMMENT DROP
  if (matureScan && !glitchComments && prevComments >= 20) {
    const C = getEffectivePair('comments');
    const drop = C.prev - C.curr;
    if (drop >= 10) {
      bottedReason += `\nmassive comment drop (-${drop})`;
      shouldReject = true;
    }
  }

  // COMMENTS JUMP WITH MINIMAL VIEW CHANGE (exclude YouTube)
  if (platform !== 'youtube' && matureScan && !glitchComments) {
    const C2 = getEffectivePair('comments');
    const viewDelta = Math.abs(C2.currViews - C2.prevViews);
    const commentJump = C2.curr - C2.prev;
    if (viewDelta <= 30 && commentJump >= 10) {
      bottedReason += `\ncomments jumped by ${commentJump} with minimal view change (+${viewDelta})`;
      shouldReject = true;
    }
  }

  // SUSPICIOUS COMMENT INJECTION
  const C3 = getEffectivePair('comments');
  const viewJumpFactor = C3.currViews / Math.max(C3.prevViews, 1);
  const commentJumpFactor = C3.curr / Math.max(C3.prev, 1);
  if (matureScan && !glitchComments && viewJumpFactor < 5 && commentJumpFactor >= 50) {
    bottedReason += `\nsus comment injection: views ${prevViews}→${scanViews} (${viewJumpFactor.toFixed(1)}x) but comments ${prevComments}→${scanComments} (${commentJumpFactor.toFixed(1)}x)`;
    shouldReject = true;
  }

  // PLATEAU PATTERN DETECTION (6-scan validation)
  if (platform !== 'youtube' && allScans && allScans.length >= 6 && typeof scanIndex === 'number') {
    try {
      // Build a 6-scan window centered around the current index where possible
      const total = allScans.length;
      const start = Math.max(0, Math.min(scanIndex - 3, total - 6));
      const scans = allScans.slice(start, start + 6);
      const isPlateau = (a: number, b: number) => {
        const absOk = Math.abs(a - b) <= 30;
        return absOk;
      };
      
      const beforePlateau = scans[0] && scans[2] &&
                            isPlateau(scans[0].views || 0, scans[2].views || 0);
      
      const hasJump = scans[3] && scans[2] &&
                      ((scans[3].views || 0) - (scans[2].views || 0) >= 500);
      
      const consecutivePlateau = scans[3] && scans[4] && scans[5] &&
                                 isPlateau(scans[3].views || 0, scans[4].views || 0) &&
                                 isPlateau(scans[4].views || 0, scans[5].views || 0);
      
      const overallChangeAbs = scans[5] && scans[3] ? 
                               Math.abs((scans[5].views || 0) - (scans[3].views || 0)) : 0;
      const overallChangeRel = scans[5] && scans[3] ? 
                               Math.abs((scans[5].views || 0) - (scans[3].views || 0)) / Math.max(scans[3].views || 1, 1) : 0;
      
      if (beforePlateau && hasJump && consecutivePlateau && (overallChangeAbs <= 30 || overallChangeRel <= 0.1)) {
        bottedReason += `\nsuspicious plateau → jump → plateau pattern (views: ${scans[0]?.views || 0} → ${scans[1]?.views || 0} → ${scans[2]?.views || 0} → ${scans[3]?.views || 0} → ${scans[4]?.views || 0} → ${scans[5]?.views || 0})`;
        shouldReject = true;
      }

      // SMALL-PLATEAU STEP PATTERN: two-scan plateau → small jump → bigger jump → 3-scan plateau
      const v0 = scans[0]?.views || 0;
      const v1 = scans[1]?.views || 0;
      const v2 = scans[2]?.views || 0;
      const v3 = scans[3]?.views || 0;
      const v4 = scans[4]?.views || 0;
      const v5 = scans[5]?.views || 0;

      const twoPlateau = isPlateau(v0, v1);
      const smallJumpDelta = v2 - v1; // should be modest but positive
      const bigJumpDelta = v3 - v2;   // should be clearly larger than small jump
      const highPlateau3 = isPlateau(v3, v4) && isPlateau(v4, v5);

      const smallJump = smallJumpDelta >= 300; // 300+ with no upper bound
      const bigJump = bigJumpDelta >= 500 && bigJumpDelta > smallJumpDelta; // 500+ and strictly larger than small jump

      if (twoPlateau && smallJump && bigJump && highPlateau3) {
        bottedReason += `\nsmall plateau-step pattern: plateau → small jump (+${smallJumpDelta}) → jump (+${bigJumpDelta}) → plateau (views: ${v0} → ${v1} → ${v2} → ${v3} → ${v4} → ${v5})`;
        shouldReject = true;
      }
    } catch (error) {
      console.log('Error in plateau detection:', error);
    }
  }

  return { shouldReject, bottedReason };
}
// ---- end algo ----

// --- helpers ---
function toInt(s: string) {
  const v = parseInt(String(s).replace(/[,\s]/g, ""), 10);
  return Number.isFinite(v) ? v : 0; // treat 'null'/'NaN' as 0
}

function isMissingCellContent(cell: string): boolean {
  const t = String(cell).replace(/<[^>]*>/g, "").trim().toLowerCase();
  return (
    t === "" ||
    t === "undefined" ||
    t === "null" ||
    t === "na" ||
    t === "n/a" ||
    t === "—" ||
    t === "-"
  );
}

function summarizeZeroLikes(
  scans: ScanData[],
  _platform: string,
  minViews = 1000,   // only count when views are meaningful
  minRun   = 5       // 5+ consecutive scans -> one summary line
): string[] {
  const msgs: string[] = [];
  let start: number | null = null;

  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    const zeroLike = s.views > minViews && s.likes === 0;

    if (zeroLike) {
      if (start === null) start = i; // start a run
    } else if (start !== null) {
      const len = i - start;
      if (len >= minRun) {
        msgs.push(`Scans ${start + 1}–${i}: zero likes across ${len} scans (may be hidden likes)`);
      }
      start = null; // end run
    }
  }

  // close a trailing run
  if (start !== null) {
    const len = scans.length - start;
    if (len >= minRun) {
      msgs.push(`Scans ${start + 1}–${scans.length}: zero likes across ${len} scans (may be hidden likes)`);
    }
  }

  return msgs;
}

function summarizeUltraLowEngagement(
  scans: ScanData[],
  platform: string,
  minViews = 20000,  // only count when views are meaningful
  minRun   = 3       // 3+ consecutive scans -> one summary line
): string[] {
  if (platform !== 'snapchat') return []; // Only for Snapchat
  
  const msgs: string[] = [];
  let start: number | null = null;

  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    const ultraLowEngagement = s.views > minViews && s.comments === 0 && s.shares <= 1;

    if (ultraLowEngagement) {
      if (start === null) start = i; // start a run
    } else if (start !== null) {
      const len = i - start;
      if (len >= minRun) {
        msgs.push(`Scans ${start + 1}–${i}: ultra-low engagement across ${len} scans (20K+ views with 0 comments and ≤1 shares)`);
      }
      start = null; // end run
    }
  }

  // close a trailing run
  if (start !== null) {
    const len = scans.length - start;
    if (len >= minRun) {
      msgs.push(`Scans ${start + 1}–${scans.length}: ultra-low engagement across ${len} scans (20K+ views with 0 comments and ≤1 shares)`);
    }
  }

  return msgs;
}

function summarizeZeroComments(
  scans: ScanData[],
  _platform: string,
  minViews = 5000,   // only count when views are meaningful
  minRun   = 3       // 3+ consecutive scans -> one summary line
): string[] {
  const msgs: string[] = [];
  let start: number | null = null;

  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    const zeroComments = s.views > minViews && s.comments === 0;

    if (zeroComments) {
      if (start === null) start = i; // start a run
    } else if (start !== null) {
      const len = i - start;
      if (len >= minRun) {
        msgs.push(`Scans ${start + 1}–${i}: zero comments across ${len} scans (5K+ views with 0 comments)`);
      }
      start = null; // end run
    }
  }

  // close a trailing run
  if (start !== null) {
    const len = scans.length - start;
    if (len >= minRun) {
      msgs.push(`Scans ${start + 1}–${scans.length}: zero comments across ${len} scans (5K+ views with 0 comments)`);
    }
  }

  return msgs;
}

function summarizeLowCommentRatio(
  scans: ScanData[],
  _platform: string,
  minViews = 5000,   // only count when views are meaningful
  minRun   = 3,      // 3+ consecutive scans -> one summary line
  threshold = 0.01   // comment ratio threshold
): string[] {
  const msgs: string[] = [];
  let start: number | null = null;

  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    const lowRatio = s.views > minViews && (s.comments / s.views) < threshold;

    if (lowRatio) {
      if (start === null) start = i; // start a run
    } else if (start !== null) {
      const len = i - start;
      if (len >= minRun) {
        msgs.push(`Scans ${start + 1}–${i}: low comment ratio across ${len} scans (5K+ views with <${(threshold * 100).toFixed(2)}% comment ratio)`);
      }
      start = null; // end run
    }
  }

  // close a trailing run
  if (start !== null) {
    const len = scans.length - start;
    if (len >= minRun) {
      msgs.push(`Scans ${start + 1}–${scans.length}: low comment ratio across ${len} scans (5K+ views with <${(threshold * 100).toFixed(2)}% comment ratio)`);
    }
  }

  return msgs;
}

function parseScans(html: string, platform?: string): ScanData[] {
  // Find ALL tables in the HTML
  const tableMatches = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)];
  
  if (tableMatches.length === 0) {
    return [];
  }
  
  // If there's only one table, use it (fallback for normal cases)
  // If there are multiple tables, use the SECOND one (index 1) which should have the real data
  const targetTableIndex = tableMatches.length > 1 ? 1 : 0;
  const targetTable = tableMatches[targetTableIndex][1];
  
  // Parse the target table
  const rows = [...targetTable.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
  
  if (!rows.length) return [];

  const scans: ScanData[] = [];
  
  // Platform-specific table structure
  let metrics: string[];
  if (platform === 'snapchat') {
    // Snapchat: views, likes, comments, shares (no saves)
    metrics = ["views", "likes", "comments", "shares"];
  } else if (platform === 'youtube' || platform === 'instagram') {
    // YouTube/Instagram: views, likes, comments (no saves, no shares)
    metrics = ["views", "likes", "comments"];
  } else {
    // Other platforms: views, likes, comments, saves, shares
    metrics = ["views", "likes", "comments", "saves", "shares"];
  }

  for (let m = 0; m < metrics.length; m++) {
    // grab all <td> in the row, then **skip the first** (the metric label cell)
    const allTds = [...rows[m + 1][1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(c => c[1]);
    const cells = allTds.slice(1); // <-- critical: drop the label cell

    cells.forEach((cell, i) => {
      if (!scans[i]) scans[i] = { views: 0, likes: 0, saves: 0, shares: 0, comments: 0 };
      const parsedValue = toInt(cell);
      const missingCell = isMissingCellContent(cell);
      if (missingCell) {
        scans[i].missing = true;
      }
      
      if (platform === 'snapchat' && metrics[m] === 'shares') {
        // For Snapchat, shares data goes into shares field (not saves)
        scans[i].shares = parsedValue;
      } else {
        // Normal mapping
        (scans[i] as any)[metrics[m]] = parsedValue;
      }
    });
  }

  const out = scans.reverse(); // oldest → newest

  // safety: drop trailing phantom columns that are all zeros
  while (
    out.length &&
    Object.values(out[out.length - 1]).every(v => v === 0)
  ) {
    out.pop();
  }
  
  return out;
}

// --- reusable analysis result type ---
interface AnalysisResult {
  url: string;
  platform: string;
  scanCount: number;
  flagged: string[];
  perScan: { index: number; reasons: string[] }[];
  zeroCommentSummaries?: string[];
  lowCommentRatioSummaries?: string[];
}

// --- reusable analysis (single URL) ---
async function analyzeUrl(url: string, opts?: { logNotes?: boolean; stream?: boolean }): Promise<AnalysisResult> {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}`);
  }
  const html = await r.text();
  const platform = inferPlatformFromUrl(url);
  const scans = parseScans(html, platform);
  const validScans = scans.filter(s => !s.missing);

  if (!validScans.length) {
    throw new Error("No scans found.");
  }

  let flagged: string[] = [];
  const perScan: { index: number; reasons: string[] }[] = [];

  // Pairwise checks (original algo)
  for (let i = 1; i < validScans.length; i++) {
    const prev = validScans[i - 1], curr = validScans[i];
    const { shouldReject, bottedReason } = detectBotAlgo({
      prevScan: prev,
      currentScan: curr,
      platform,
      scanIndex: i,
      allScans: validScans,
      logNotes: !!opts?.logNotes
    });
    const reasons = (bottedReason || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    const line = reasons.length
      ? `Scan ${i}: Anomalie : ${reasons.join('; ')}`
      : `Scan ${i}: No anomalies`;
    if (shouldReject && reasons.length) {
      flagged.push(line);
    }
    perScan.push({ index: i, reasons });
    if (opts?.stream) {
      console.log(line);
    }
  }

  // Only summarize zero-likes where likes are meaningful (skip Snapchat/unknown)
  if (["tiktok", "instagram", "youtube"].includes(platform)) {
    const zeroLikeSummaries = summarizeZeroLikes(validScans, platform, 1000, 5);
    if (zeroLikeSummaries.length) {
      const filtered = flagged.filter(line => !/\bzero likes\b/.test(line));
      flagged.length = 0;
      flagged.push(...filtered, ...zeroLikeSummaries);
    }
  }

  // Summarize ultra-low engagement for Snapchat
  if (platform === 'snapchat') {
    const ultraLowEngagementSummaries = summarizeUltraLowEngagement(validScans, platform, 20000, 3);
    if (ultraLowEngagementSummaries.length) {
      const filtered = flagged.filter(line => !/\bultra-low engagement\b/.test(line));
      flagged.length = 0;
      flagged.push(...filtered, ...ultraLowEngagementSummaries);
    }
  }

  // Prepare non-blocking summaries
  let zeroCommentSummaries: string[] | undefined;
  let lowCommentRatioSummaries: string[] | undefined;
  if (["tiktok", "instagram", "youtube"].includes(platform)) {
    zeroCommentSummaries = summarizeZeroComments(validScans, platform, 5000, 3);
    lowCommentRatioSummaries = summarizeLowCommentRatio(validScans, platform, 5000, 3, 0.01);
  }

  return {
    url,
    platform,
    scanCount: scans.length,
    flagged,
    perScan,
    zeroCommentSummaries,
    lowCommentRatioSummaries
  };
}

// --- batch runner (mass verification) ---
async function runBatch(listPath: string, format: 'text' | 'json' = 'text') {
  const raw = await fsReadFile(listPath, { encoding: 'utf-8' });
  const urls = raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('#'));

  const results: AnalysisResult[] = [];
  for (let idx = 0; idx < urls.length; idx++) {
    const url = urls[idx];
    try {
      const r = await analyzeUrl(url, { logNotes: false, stream: false });
      if (format === 'json') {
        results.push(r);
      } else {
        if (r.flagged.length) {
          console.log(`url${idx + 1}: 🚩 (${r.flagged.join(' | ')})`);
        } else {
          console.log(`url${idx + 1}: ✅ No anomalies detected`);
        }
      }
    } catch (e: any) {
      const r: AnalysisResult = { url, platform: 'unknown', scanCount: 0, flagged: [`Error: ${e?.message || e}`], perScan: [] };
      if (format === 'json') {
        results.push(r);
      } else {
        console.log(`url${idx + 1}: 🚩 (${r.flagged.join(' | ')})`);
      }
    }
  }

  if (format === 'json') {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
}

// --- main interactive loop ---
async function runOnce(url: string) {
  const result = await analyzeUrl(url, { logNotes: true, stream: false });
  // Single URL mode: show condensed URL-level summary per your format
  if (result.flagged.length) {
    console.log(`url1: 🚩 (${result.flagged.join(' | ')})`);
  } else {
    console.log(`url1: ✅ No anomalies detected`);
  }
}

async function main() {
  // Simple CLI arg parsing
  const args = process.argv.slice(2);
  let listPath: string | undefined;
  let format: 'text' | 'json' = 'text';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list' || a === '-l') {
      listPath = args[i + 1];
      i++;
    } else if (a === '--format' || a === '-f') {
      const v = (args[i + 1] || '').toLowerCase();
      if (v === 'json') format = 'json';
      i++;
    }
  }

  if (listPath) {
    try {
      await runBatch(listPath, format);
    } catch (e) {
      console.error('Batch error:', e);
      process.exitCode = 1;
    }
    return;
  }

  // Fallback: interactive single-URL mode
  const rl = createInterface({input,output});
  while (true) {
    const url = await new Promise<string>(res=>rl.question("\nPaste dump-data URL (or type 'q'): ",res));
    if (url.trim().toLowerCase() === "q") break;
    try { await runOnce(url.trim()); }
    catch(e){ console.error("Error:", e); }
  }
  rl.close();
}

main().catch(e=>console.error(e));
