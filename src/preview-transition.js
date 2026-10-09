export function approachValue(current, target, elapsedSeconds, responseSeconds = 0.14) {
  if (![current, target, elapsedSeconds, responseSeconds].every(Number.isFinite) || elapsedSeconds < 0 || responseSeconds <= 0) {
    throw new TypeError('Transitions require finite values, nonnegative time and a positive response.');
  }
  const next = current + (target - current) * -Math.expm1(-elapsedSeconds / responseSeconds);
  return Math.abs(next - target) < 0.0005 ? target : next;
}
