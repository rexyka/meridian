import { buildSignalSummary, fetchChartIndicatorsForMint } from "./chart-indicators.js";
import { getGmgnHolderExitSignalsForMint } from "./gmgn.js";
import { getRecentPositionSnapshots } from "../pool-memory.js";
import { getTrackedPosition } from "../state.js";
import { log } from "../logger.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

const DEFAULTS = {
  tpZonePnlPct: 3,
  tpSeriousPnlPct: 5,
  tpZoneRsi5m: 85,
  tpSeriousRsi5m: 90,
  tpSeriousRsi15m: 80,
  upperBbPct: 0.8,
  seriousUpperBbPct: 0.85,
  weaknessRsi5m: 50,
  weaknessRsi15m: 60,
  dumpRsi5m: 35,
  rangePressureBins: 8,
  rangePressurePct: 0.2,
  binVelocityDrop: 8,
  volumeFadeRatio: 0.5,
  feeDecayMinAgeMinutes: 30,
  feeDecayLookbackSnapshots: 6,
  feeDecayMaxFeeGrowthUsd: 0.05,
  feeDecayMaxFeePerTvl24h: 2,
  feeDecayMaxPnlPct: 1,
  liquidityDrainPct: 25,
  activeTvlDrainPct: 35,
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(value) {
  const n = num(value);
  return n == null ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtNum(value, digits = 1) {
  const n = num(value);
  return n == null ? "?" : n.toFixed(digits);
}

function isNearUpperBb(signal, threshold) {
  if (!signal) return false;
  return signal.bbPosition === "above" ||
    (signal.bbPositionPct != null && signal.bbPositionPct >= threshold);
}

function isBelowMiddle(signal) {
  return signal?.close != null &&
    signal?.middleBand != null &&
    signal.close < signal.middleBand;
}

function isBelowLower(signal) {
  return signal?.close != null &&
    signal?.lowerBand != null &&
    signal.close < signal.lowerBand;
}

function isBelowSupertrend(signal) {
  return signal?.close != null &&
    signal?.supertrendValue != null &&
    signal.close < signal.supertrendValue;
}

async function fetchSignalContext(mint, interval) {
  const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh: true });
  return {
    payload,
    signal: buildSignalSummary(payload),
  };
}

async function fetchPoolDetail(poolAddress, timeframe = "5m") {
  if (!poolAddress) return null;
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(timeframe)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool detail ${res.status}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

function getPoolMetric(poolDetail, key) {
  return num(poolDetail?.[key]);
}

function getVolumeFade(detail5m, detail1h, threshold) {
  const volume5m = getPoolMetric(detail5m, "volume");
  const volume1h = getPoolMetric(detail1h, "volume");
  if (volume5m == null || volume1h == null || volume1h <= 0) return null;
  const avg5mFrom1h = volume1h / 12;
  if (avg5mFrom1h <= 0) return null;
  const ratio = volume5m / avg5mFrom1h;
  return {
    volume5m,
    volume1h,
    avg5mFrom1h,
    ratio,
    fading: ratio <= threshold,
  };
}

function getMacdValues(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const macd = num(raw.macd ?? raw.value ?? raw.macdValue);
  const signal = num(raw.signal ?? raw.signalValue ?? raw.signal_line ?? raw.signalLine);
  const histogram = num(raw.histogram ?? raw.hist ?? raw.diff);
  if (macd == null && signal == null && histogram == null) return null;
  return { macd, signal, histogram };
}

function getMacdBearishContext(payload) {
  const latest = payload?.latest || {};
  const current = getMacdValues(latest.macd || payload?.macd);
  const previous = getMacdValues(
    latest.previousMacd ||
    latest.previous_macd ||
    latest.previous?.macd ||
    payload?.previousMacd ||
    payload?.previous?.macd,
  );

  if (!current) return null;

  const currentBearish =
    current.macd != null &&
    current.signal != null &&
    current.macd < current.signal;
  const histogramBearish = current.histogram != null && current.histogram < 0;
  const crossedBearish =
    previous?.macd != null &&
    previous?.signal != null &&
    current.macd != null &&
    current.signal != null &&
    previous.macd >= previous.signal &&
    current.macd < current.signal;
  const histogramCrossedBearish =
    previous?.histogram != null &&
    current.histogram != null &&
    previous.histogram >= 0 &&
    current.histogram < 0;

  return {
    bearish: crossedBearish || histogramCrossedBearish || currentBearish || histogramBearish,
    crossedBearish,
    histogramCrossedBearish,
    current,
    previous,
  };
}

function getFeeDecay(position, thresholds) {
  const age = num(position.age_minutes);
  if (age == null || age < thresholds.feeDecayMinAgeMinutes) return null;

  const snapshots = getRecentPositionSnapshots(position.pool, {
    position: position.position,
    limit: thresholds.feeDecayLookbackSnapshots,
  }).filter((snapshot) => num(snapshot.unclaimed_fees_usd) != null);

  if (snapshots.length < 3) return null;

  const first = snapshots[0];
  const currentFees = num(position.unclaimed_fees_usd);
  const firstFees = num(first.unclaimed_fees_usd);
  const feeGrowthUsd = currentFees != null && firstFees != null
    ? currentFees - firstFees
    : null;
  const feePerTvl24h = num(position.fee_per_tvl_24h);
  const pnlPct = num(position.pnl_pct);
  const decaying =
    feeGrowthUsd != null &&
    feeGrowthUsd <= thresholds.feeDecayMaxFeeGrowthUsd &&
    (feePerTvl24h == null || feePerTvl24h <= thresholds.feeDecayMaxFeePerTvl24h) &&
    (pnlPct == null || pnlPct <= thresholds.feeDecayMaxPnlPct);

  return {
    decaying,
    feeGrowthUsd,
    feePerTvl24h,
    pnlPct,
    samples: snapshots.length,
  };
}

function latestPreviousActiveBin(position) {
  const snapshots = getRecentPositionSnapshots(position.pool, {
    position: position.position,
    limit: 4,
  });
  const currentActive = num(position.active_bin);
  const previous = snapshots
    .slice(0, -1)
    .reverse()
    .find((snapshot) => num(snapshot.active_bin) != null);

  const previousActive = num(previous?.active_bin);
  if (currentActive == null || previousActive == null) return null;
  return {
    previousActive,
    currentActive,
    delta: currentActive - previousActive,
  };
}

function getRangeMetrics(position) {
  const active = num(position.active_bin);
  const lower = num(position.lower_bin);
  const upper = num(position.upper_bin);
  if (active == null || lower == null || upper == null || upper <= lower) return null;

  const distanceToLower = active - lower;
  const rangeWidth = upper - lower;
  const rangePct = distanceToLower / rangeWidth;
  return {
    active,
    lower,
    upper,
    distanceToLower,
    rangeWidth,
    rangePct,
  };
}

function pushAlert(alerts, type, severity, reason, data = {}) {
  alerts.push({ type, severity, reason, data });
}

export async function evaluateExitAlertsForPosition(position, thresholds = DEFAULTS) {
  if (!position?.base_mint) return [];

  let signal5m = null;
  let signal15m = null;
  let payload5m = null;
  const results = await Promise.allSettled([
    fetchSignalContext(position.base_mint, "5_MINUTE"),
    fetchSignalContext(position.base_mint, "15_MINUTE"),
  ]);

  if (results[0].status === "fulfilled") {
    signal5m = results[0].value.signal;
    payload5m = results[0].value.payload;
  }
  else log("exit_alerts_warn", `5m indicators failed for ${position.pair || position.base_mint}: ${results[0].reason?.message || results[0].reason}`);

  if (results[1].status === "fulfilled") signal15m = results[1].value.signal;
  else log("exit_alerts_warn", `15m indicators failed for ${position.pair || position.base_mint}: ${results[1].reason?.message || results[1].reason}`);

  const [detail5mResult, detail1hResult, smartExitResult] = await Promise.allSettled([
    fetchPoolDetail(position.pool, "5m"),
    fetchPoolDetail(position.pool, "1h"),
    getGmgnHolderExitSignalsForMint(position.base_mint),
  ]);

  const poolDetail5m = detail5mResult.status === "fulfilled" ? detail5mResult.value : null;
  const poolDetail1h = detail1hResult.status === "fulfilled" ? detail1hResult.value : null;
  if (detail5mResult.status !== "fulfilled") {
    log("exit_alerts_warn", `5m pool detail failed for ${position.pair || position.pool}: ${detail5mResult.reason?.message || detail5mResult.reason}`);
  }
  const smartExit = smartExitResult.status === "fulfilled" ? smartExitResult.value : null;

  const alerts = [];
  const pnlPct = num(position.pnl_pct);
  const rsi5m = num(signal5m?.rsi);
  const rsi15m = num(signal15m?.rsi);
  const range = getRangeMetrics(position);
  const velocity = latestPreviousActiveBin(position);
  const volumeFade = getVolumeFade(poolDetail5m, poolDetail1h, thresholds.volumeFadeRatio);
  const macdBearish = getMacdBearishContext(payload5m);
  const feeDecay = getFeeDecay(position, thresholds);
  const tracked = getTrackedPosition(position.position);

  const tpZone =
    pnlPct != null &&
    pnlPct >= thresholds.tpZonePnlPct &&
    rsi5m != null &&
    rsi5m >= thresholds.tpZoneRsi5m &&
    isNearUpperBb(signal5m, thresholds.upperBbPct);

  const tpSerious =
    pnlPct != null &&
    pnlPct >= thresholds.tpSeriousPnlPct &&
    rsi5m != null &&
    rsi5m >= thresholds.tpSeriousRsi5m &&
    rsi15m != null &&
    rsi15m >= thresholds.tpSeriousRsi15m &&
    isNearUpperBb(signal5m, thresholds.seriousUpperBbPct);

  if (tpSerious) {
    pushAlert(
      alerts,
      "TP_SERIOUS_ZONE",
      "high",
      `PnL ${fmtPct(pnlPct)}, RSI_5m=${fmtNum(rsi5m)}, RSI_15m=${fmtNum(rsi15m)}, BB_5m=${signal5m.bbPosition} ${fmtNum(signal5m.bbPositionPct, 2)}.`,
      { pnlPct, rsi5m, rsi15m, bb5m: signal5m.bbPositionPct },
    );
  } else if (tpZone) {
    pushAlert(
      alerts,
      "TP_ZONE",
      "medium",
      `PnL ${fmtPct(pnlPct)}, RSI_5m=${fmtNum(rsi5m)}, BB_5m=${signal5m.bbPosition} ${fmtNum(signal5m.bbPositionPct, 2)}.`,
      { pnlPct, rsi5m, bb5m: signal5m.bbPositionPct },
    );
  }

  if ((tpSerious || tpZone) && volumeFade?.fading) {
    pushAlert(
      alerts,
      "TP_EXHAUSTION_VOLUME_FADE",
      tpSerious ? "high" : "medium",
      `TP zone with fading volume: 5m volume $${fmtNum(volumeFade.volume5m, 0)} is ${fmtNum(volumeFade.ratio, 2)}x the 1h average 5m volume.`,
      volumeFade,
    );
  }

  const weakness =
    signal5m &&
    isBelowMiddle(signal5m) &&
    rsi5m != null &&
    rsi5m < thresholds.weaknessRsi5m &&
    (
      rsi15m == null ||
      rsi15m < thresholds.weaknessRsi15m ||
      isBelowMiddle(signal15m)
    );
  if (weakness) {
    pushAlert(
      alerts,
      "WEAKNESS_WARNING",
      "medium",
      `Price below BB middle with RSI_5m=${fmtNum(rsi5m)}${rsi15m != null ? `, RSI_15m=${fmtNum(rsi15m)}` : ""}.`,
      { rsi5m, rsi15m },
    );
  }

  if ((tpSerious || tpZone || weakness) && macdBearish?.bearish) {
    const crossText = macdBearish.crossedBearish || macdBearish.histogramCrossedBearish
      ? "bearish cross"
      : "bearish momentum";
    pushAlert(
      alerts,
      "MACD_BEARISH_CONFIRMATION",
      "medium",
      `${crossText} confirms ${weakness ? "weakness" : "TP exhaustion"} context.`,
      macdBearish,
    );
  }

  const dumpRisk =
    signal5m &&
    (
      (isBelowLower(signal5m) && (rsi5m == null || rsi5m < thresholds.dumpRsi5m)) ||
      (isBelowSupertrend(signal5m) && rsi5m != null && rsi5m < thresholds.weaknessRsi5m)
    );
  if (dumpRisk) {
    const trigger = isBelowLower(signal5m) ? "below lower BB" : "below Supertrend";
    pushAlert(
      alerts,
      "DUMP_RISK",
      "high",
      `Price ${trigger}; RSI_5m=${fmtNum(rsi5m)}. Downside bins may fill into token inventory.`,
      { rsi5m, belowLowerBb: isBelowLower(signal5m), belowSupertrend: isBelowSupertrend(signal5m) },
    );
  }

  if (
    range &&
    (
      range.distanceToLower <= thresholds.rangePressureBins ||
      range.rangePct <= thresholds.rangePressurePct ||
      range.active < range.lower
    )
  ) {
    pushAlert(
      alerts,
      "RANGE_PRESSURE",
      "high",
      `Active bin ${range.active} is ${range.distanceToLower} bin(s) from lower range ${range.lower} (${fmtNum(range.rangePct * 100, 1)}% of range).`,
      range,
    );
  }

  if (velocity && velocity.delta <= -thresholds.binVelocityDrop) {
    pushAlert(
      alerts,
      "BIN_VELOCITY",
      "high",
      `Active bin dropped ${Math.abs(velocity.delta)} bins since last snapshot (${velocity.previousActive} -> ${velocity.currentActive}).`,
      velocity,
    );
  }

  if (feeDecay?.decaying) {
    pushAlert(
      alerts,
      "FEE_DECAY",
      "medium",
      `Fees are not growing: +$${fmtNum(feeDecay.feeGrowthUsd, 2)} over ${feeDecay.samples} snapshots, fee/TVL=${fmtNum(feeDecay.feePerTvl24h, 2)}%, PnL ${fmtPct(feeDecay.pnlPct)}.`,
      feeDecay,
    );
  }

  const initialTvl = num(tracked?.initial_value_usd);
  const currentTvl = getPoolMetric(poolDetail5m, "tvl");
  const currentActiveTvl = getPoolMetric(poolDetail5m, "active_tvl");
  if (initialTvl != null && initialTvl > 0 && currentTvl != null) {
    const dropPct = ((initialTvl - currentTvl) / initialTvl) * 100;
    if (dropPct >= thresholds.liquidityDrainPct) {
      pushAlert(
        alerts,
        "LIQUIDITY_DRAIN",
        "high",
        `Pool TVL dropped ${fmtNum(dropPct, 1)}% since deploy snapshot ($${fmtNum(initialTvl, 0)} -> $${fmtNum(currentTvl, 0)}).`,
        { initialTvl, currentTvl, currentActiveTvl, dropPct },
      );
    }
  }

  const activeTvl = currentActiveTvl;
  const tvl = currentTvl;
  if (activeTvl != null && tvl != null && tvl > 0) {
    const activeTvlPct = (activeTvl / tvl) * 100;
    if (activeTvlPct <= 100 - thresholds.activeTvlDrainPct) {
      pushAlert(
        alerts,
        "LIQUIDITY_DRAIN",
        "medium",
        `Active TVL is thin: $${fmtNum(activeTvl, 0)} active of $${fmtNum(tvl, 0)} TVL (${fmtNum(activeTvlPct, 1)}%).`,
        { activeTvl, tvl, activeTvlPct },
      );
    }
  }

  if (
    smartExit &&
    (
      (smartExit.smartExiting > smartExit.smartAccumulating && smartExit.smartExiting > 0) ||
      smartExit.mostlyExited > 0 ||
      smartExit.dumpKolSignificantCount > 0
    )
  ) {
    pushAlert(
      alerts,
      "SMART_WALLET_EXIT",
      "high",
      `GMGN smart/KOL flow weakened: smart exiting=${smartExit.smartExiting}, accumulating=${smartExit.smartAccumulating}, mostly exited=${smartExit.mostlyExited}, dump KOL=${smartExit.dumpKolSignificantCount}.`,
      smartExit,
    );
  }

  return alerts;
}

export async function evaluateExitAlertsForPositions(positions) {
  const results = await Promise.all(
    positions.map(async (position) => {
      try {
        const alerts = await evaluateExitAlertsForPosition(position);
        return { position: position.position, alerts };
      } catch (error) {
        log("exit_alerts_warn", `Exit alert evaluation failed for ${position.pair || position.position}: ${error.message}`);
        return { position: position.position, alerts: [] };
      }
    }),
  );
  return new Map(results.map((result) => [result.position, result.alerts]));
}

export function summarizeExitAlertCluster(alerts = []) {
  const types = new Set(alerts.map((alert) => alert.type));
  const has = (type) => types.has(type);
  const highCount = alerts.filter((alert) => alert.severity === "high").length;

  if (!alerts.length) {
    return {
      level: "OK",
      color: "green",
      icon: "🟢",
      label: "OK",
      reason: "No exit alerts.",
    };
  }

  const strongReasons = [];
  if (has("DUMP_RISK") && has("SMART_WALLET_EXIT")) {
    strongReasons.push("dump risk plus smart-wallet exit");
  }
  if (has("DUMP_RISK") && has("RANGE_PRESSURE")) {
    strongReasons.push("dump risk near lower range");
  }
  if (has("DUMP_RISK") && has("BIN_VELOCITY")) {
    strongReasons.push("fast bin drop during dump risk");
  }
  if (has("SMART_WALLET_EXIT") && has("WEAKNESS_WARNING")) {
    strongReasons.push("smart wallets exiting while price is weak");
  }
  if (has("TP_SERIOUS_ZONE") && has("TP_EXHAUSTION_VOLUME_FADE")) {
    strongReasons.push("serious TP zone with fading volume");
  }
  if (has("LIQUIDITY_DRAIN") && (has("WEAKNESS_WARNING") || has("DUMP_RISK"))) {
    strongReasons.push("liquidity drain with weak price action");
  }

  if (strongReasons.length || highCount >= 2) {
    return {
      level: "MANUAL_EXIT_STRONG",
      color: "red",
      icon: "🔴",
      label: "MANUAL_EXIT_STRONG",
      reason: strongReasons[0] || `${highCount} high-severity alerts clustered`,
    };
  }

  if (
    highCount >= 1 ||
    has("TP_SERIOUS_ZONE") ||
    has("DUMP_RISK") ||
    has("RANGE_PRESSURE") ||
    has("BIN_VELOCITY") ||
    has("SMART_WALLET_EXIT") ||
    has("TP_EXHAUSTION_VOLUME_FADE")
  ) {
    return {
      level: "CAUTION",
      color: "yellow",
      icon: "🟡",
      label: "CAUTION",
      reason: "High-risk or profit-exhaustion alert present.",
    };
  }

  if (
    has("WEAKNESS_WARNING") ||
    has("FEE_DECAY") ||
    has("LIQUIDITY_DRAIN") ||
    has("MACD_BEARISH_CONFIRMATION")
  ) {
    return {
      level: "WATCH",
      color: "yellow",
      icon: "🟡",
      label: "WATCH",
      reason: "Early weakness or decay alert present.",
    };
  }

  return {
    level: "INFO",
    color: "green",
    icon: "🟢",
    label: "INFO",
    reason: "Informational exit context only.",
  };
}

export function formatExitAlerts(alerts = []) {
  if (!alerts.length) return "";
  const cluster = summarizeExitAlertCluster(alerts);
  const header = `Exit alert cluster ${cluster.icon} ${cluster.label}: ${cluster.reason}`;
  return alerts
    .map((alert) => `Exit alert ${alert.type}: ${alert.reason}`)
    .reduce((lines, line) => [...lines, line], [header, "Alert-only: no auto-close executed."])
    .join("\n");
}
