/** Communities used for labels + quick-jump (one list per region). pop = approx. population. */
export interface Place {
  name: string;
  lat: number;
  lng: number;
  pop: number;
  /** Landmark labels only show up close. */
  landmark?: boolean;
}

export const ALBERTA_PLACES: Place[] = [
  { name: "Calgary", lat: 51.0447, lng: -114.0719, pop: 1_400_000 },
  { name: "Edmonton", lat: 53.5461, lng: -113.4938, pop: 1_100_000 },
  { name: "Red Deer", lat: 52.2681, lng: -113.8112, pop: 110_000 },
  { name: "Lethbridge", lat: 49.6935, lng: -112.8418, pop: 106_000 },
  { name: "St. Albert", lat: 53.6305, lng: -113.6256, pop: 70_000 },
  { name: "Medicine Hat", lat: 50.0405, lng: -110.6764, pop: 65_000 },
  { name: "Grande Prairie", lat: 55.1707, lng: -118.7947, pop: 67_000 },
  { name: "Airdrie", lat: 51.2917, lng: -114.0144, pop: 80_000 },
  { name: "Fort McMurray", lat: 56.7267, lng: -111.381, pop: 68_000 },
  { name: "Lloydminster", lat: 53.2783, lng: -110.005, pop: 32_000 },
  { name: "Camrose", lat: 53.0167, lng: -112.8333, pop: 19_000 },
  { name: "Cold Lake", lat: 54.4642, lng: -110.1825, pop: 16_000 },
  { name: "Brooks", lat: 50.5642, lng: -111.8989, pop: 15_000 },
  { name: "Okotoks", lat: 50.7256, lng: -113.9749, pop: 31_000 },
  { name: "Cochrane", lat: 51.1894, lng: -114.4686, pop: 35_000 },
  { name: "Canmore", lat: 51.089, lng: -115.359, pop: 16_000 },
  { name: "Banff", lat: 51.1784, lng: -115.5708, pop: 8_000 },
  { name: "Jasper", lat: 52.8737, lng: -118.0814, pop: 5_000 },
  { name: "Hinton", lat: 53.4053, lng: -117.5754, pop: 10_000 },
  { name: "Whitecourt", lat: 54.1427, lng: -115.6853, pop: 10_000 },
  { name: "Slave Lake", lat: 55.2828, lng: -114.769, pop: 7_000 },
  { name: "Peace River", lat: 56.2336, lng: -117.2897, pop: 7_000 },
  { name: "High Level", lat: 58.5169, lng: -117.136, pop: 4_000 },
  { name: "Athabasca", lat: 54.7196, lng: -113.2854, pop: 3_000 },
  { name: "Drumheller", lat: 51.4636, lng: -112.7086, pop: 8_000 },
  { name: "Fort Chipewyan", lat: 58.7131, lng: -111.1522, pop: 1_000 },
  { name: "Rocky Mountain House", lat: 52.3766, lng: -114.9187, pop: 7_000 },
  { name: "Edson", lat: 53.5817, lng: -116.4396, pop: 8_000 },
  { name: "Bonnyville", lat: 54.2681, lng: -110.7358, pop: 6_000 },
  { name: "Pincher Creek", lat: 49.4858, lng: -113.9506, pop: 4_000 },
];
