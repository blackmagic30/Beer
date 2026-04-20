export const TARGET_BEERS = [
  {
    name: "Guinness",
    aliases: ["guinness"],
  },
] as const;

export type BeerName = (typeof TARGET_BEERS)[number]["name"];
