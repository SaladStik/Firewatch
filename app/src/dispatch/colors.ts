/** Crew colours (map pins and crew sheets). */
export const CREW_COLORS = ["#ff7a1a", "#2ec4ff", "#b06cff", "#2ee38a", "#ffd23f", "#ff4fa3", "#7bdcb5", "#f25c54", "#9aa5ff", "#e0b0ff"];
export const crewColor = (i: number) => CREW_COLORS[i % CREW_COLORS.length];
