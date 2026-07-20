const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function diffDaysSigned(target, now) {
  const milliseconds = startOfDay(target) - startOfDay(now);
  if (milliseconds === 0) return 0;
  return Math.round(milliseconds / DAY_MS);
}

function distanceRank(date, now) {
  const delta = diffDaysSigned(date, now);
  if (delta === 0) return { rank: 0, distance: 0 };
  if (delta > 0) return { rank: 1, distance: delta };
  return { rank: 2, distance: Math.abs(delta) };
}

export function sortEventsByRelevance(events, now) {
  return [...events].sort((a, b) => {
    const rankA = distanceRank(a.date, now);
    const rankB = distanceRank(b.date, now);
    if (rankA.rank !== rankB.rank) return rankA.rank - rankB.rank;
    if (rankA.distance !== rankB.distance) return rankA.distance - rankB.distance;
    return a.date - b.date;
  });
}

export function minuteIdentity(date) {
  return Math.floor(date.getTime() / 60_000);
}
