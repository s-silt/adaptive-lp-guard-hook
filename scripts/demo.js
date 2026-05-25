const config = {
  baseFeeBps: 30,
  minFeeBps: 5,
  maxFeeBps: 300,
  volatilityThresholdTicks: 50,
  imbalanceThresholdBps: 1_500
};

function decide(label, referenceTick, currentTick, amountSpecified, imbalanceScoreBps, pressureDirection, cooldownActive) {
  const deviation = Math.abs(referenceTick - currentTick);
  let fee = config.baseFeeBps;
  let reasonFlags = 0;
  let regime = "calm";

  if (deviation >= config.volatilityThresholdTicks) {
    fee += 50 + Math.floor((deviation - config.volatilityThresholdTicks) / 3);
    reasonFlags |= 1;
    regime = "volatile";
  }

  if (pressureDirection !== 0 && amountSpecified >= 1_000 && imbalanceScoreBps >= config.imbalanceThresholdBps) {
    fee += 50;
    reasonFlags |= 2;
  }

  if (cooldownActive) {
    fee += 25;
    reasonFlags |= 4;
  }

  if (fee > config.maxFeeBps) {
    fee = config.maxFeeBps;
    reasonFlags |= 8;
  }

  return { label, feeBps: fee, regime, volatilityTicks: deviation, imbalanceScoreBps, reasonFlags };
}

const scenarios = [
  decide("calm swap", 1000, 1010, 300, 0, 0, false),
  decide("volatile swap", 1000, 1125, 300, 0, 0, false),
  decide("large same-direction pressure", 1000, 1010, 2_000, 2_500, 1, false),
  decide("cooldown protected swap", 1000, 1010, 300, 0, 0, true)
];

for (const scenario of scenarios) {
  console.log(
    `${scenario.label}: fee=${scenario.feeBps}bps regime=${scenario.regime} volatilityTicks=${scenario.volatilityTicks} imbalance=${scenario.imbalanceScoreBps} flags=${scenario.reasonFlags}`
  );
}
