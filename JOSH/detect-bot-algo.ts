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

export function detectBotAlgo({
  prevScan,
  currentScan,
  platform,
  scanIndex,
  allScans,
  logNotes,
}: Props): BotDetectorAlgoResponse {
  const {
    views: scanViews,
    likes: scanLikes,
    saves: scanSaves,
    shares: scanShares,
    comments: scanComments,
  } = currentScan;
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
  const hasNext = allScans && typeof scanIndex === 'number' && scanIndex + 1 < (allScans?.length || 0);
  const hasPrevPrev = allScans && typeof scanIndex === 'number' && scanIndex - 2 >= 0;
  const nextScan = hasNext ? (allScans as any)[scanIndex + 1] : undefined;
  const prevPrevScan = hasPrevPrev ? (allScans as any)[scanIndex - 2] : undefined;

  const glitchLikes =
    (isZeroish(scanLikes) && !!nextScan && prevLikes > 0 && toNum(nextScan?.likes) > 0) ||
    (isZeroish(prevLikes) && !!prevPrevScan && toNum(prevPrevScan?.likes) > 0 && scanLikes > 0);
  const glitchComments =
    (isZeroish(scanComments) && !!nextScan && prevComments > 0 && toNum(nextScan?.comments) > 0) ||
    (isZeroish(prevComments) && !!prevPrevScan && toNum(prevPrevScan?.comments) > 0 && scanComments > 0);
  const glitchSaves =
    (isZeroish(scanSaves) && !!nextScan && prevSaves > 0 && toNum(nextScan?.saves) > 0) ||
    (isZeroish(prevSaves) && !!prevPrevScan && toNum(prevPrevScan?.saves) > 0 && scanSaves > 0);
  const glitchShares =
    (isZeroish(scanShares) && !!nextScan && prevShares > 0 && toNum(nextScan?.shares) > 0) ||
    (isZeroish(prevShares) && !!prevPrevScan && toNum(prevPrevScan?.shares) > 0 && scanShares > 0);

  type MetricKey = 'likes' | 'comments' | 'saves' | 'shares';
  const getEffectivePair = (key: MetricKey) => {
    // Default: use the current boundary prev→curr
    const pVal = toNum((prevScan as any)[key]);
    let cVal = toNum((currentScan as any)[key]);
    const pViews = prevViews;
    let cViews = scanViews;
    let bridged = false;
    if (
      hasNext &&
      isZeroish((currentScan as any)[key]) &&
      toNum((prevScan as any)[key]) > 0 &&
      toNum(nextScan?.[key]) > 0
    ) {
      // Bridge over the middle scan (current)
      cVal = toNum(nextScan?.[key]);
      cViews = toNum(nextScan?.views);
      bridged = true;
    }
    return { prev: pVal, curr: cVal, prevViews: pViews, currViews: cViews, bridged };
  };

  // Run sharp-change anomaly rules on every scan after the first
  const matureScan = typeof scanIndex === 'number' && scanIndex >= 1;

  // Compute how many leading scans have zero views (to adjust early-scan rules)
  let leadingZeroCount = 0;
  if (Array.isArray(allScans)) {
    const scansArr = allScans as ScanData[];
    for (let i = 0; i < scansArr.length; i++) {
      if ((scansArr[i]?.views || 0) === 0) {
        leadingZeroCount++;
      } else {
        break;
      }
    }
  }

  // EARLY 20K VIEW JUMP IN FIRST 5 SCANS (index adjusted for leading zeros)
  if (matureScan && typeof scanIndex === 'number' && scanIndex - leadingZeroCount < 4) {
    if (scanViews - prevViews >= 20000) {
      bottedReason += '\nearly 20k+ view jump within first 5 scans';
      shouldReject = true;
    }
  }

  // LIKES ANOMALIES (exclude YouTube and Snapchat - Snapchat likes unavailable)
  if (platform !== 'youtube' && platform !== 'snapchat') {
    const L = getEffectivePair('likes');
    if (L.currViews > 1000 && L.currViews > L.prevViews * 2 && L.curr < L.prev * 1.2) {
      bottedReason += '\nviews doubled quickly without corresponding jump in likes';
      shouldReject = true;
    }

    // Views jumped by 500+ but likes changed by <2
    if (matureScan && !glitchLikes && L.currViews - L.prevViews >= 1000 && L.curr - L.prev < 2) {
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

  // TIKTOK: ZERO SAVES WITH 5K+ VIEWS
  if (platform === 'tiktok' && scanViews >= 5000 && scanSaves === 0 && !glitchSaves) {
    bottedReason += '\nzero saves at 5k+ views (TikTok)';
    shouldReject = true;
  }

  // TIKTOK: ZERO SHARES WITH 10K+ VIEWS
  if (platform === 'tiktok' && scanViews >= 10000 && scanShares === 0 && !glitchShares) {
    bottedReason += '\nzero shares at 10k+ views (TikTok)';
    shouldReject = true;
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
    const bigJump = Lr.currViews >= Lr.prevViews * 5 || Lr.currViews - Lr.prevViews >= 5000;

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

      const beforePlateau = scans[0] && scans[2] && isPlateau(scans[0].views || 0, scans[2].views || 0);

      const hasJump = scans[3] && scans[2] && (scans[3].views || 0) - (scans[2].views || 0) >= 500;

      const consecutivePlateau =
        scans[3] &&
        scans[4] &&
        scans[5] &&
        isPlateau(scans[3].views || 0, scans[4].views || 0) &&
        isPlateau(scans[4].views || 0, scans[5].views || 0);

      const overallChangeAbs = scans[5] && scans[3] ? Math.abs((scans[5].views || 0) - (scans[3].views || 0)) : 0;
      const overallChangeRel =
        scans[5] && scans[3]
          ? Math.abs((scans[5].views || 0) - (scans[3].views || 0)) / Math.max(scans[3].views || 1, 1)
          : 0;

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
      const bigJumpDelta = v3 - v2; // should be clearly larger than small jump
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
