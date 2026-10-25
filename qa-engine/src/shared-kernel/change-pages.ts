/* Why a page of the app's map is one of the change's pages: the map links it (a changed file implements it, declares it, or is the spec of an operation it joins), or the call graph proves the change reaches it. */
export const CHANGE_PAGE_BASES = ["implementation", "source", "spec", "graph"] as const;
export type ChangePageBasis = (typeof CHANGE_PAGE_BASES)[number];

/* A page the call graph proved the change reaches, with the shortest proof: from the changed symbol (or the link crossed) to the page, symbol and file names only. */
export interface GraphPage {
  route: string;
  proof: string[];
}

/* What the change-page join found: the pages it adds, the changed symbols that reached too many pages to add any (hubs), the pages the engine and the map name different files for, and how many proven pages the cap left out. */
export interface ChangePagesJoin {
  pages: GraphPage[];
  hubs: Array<{ symbol: string; pages: number; /* The pages it reached, sorted: too many to name as change pages, they only order the DOM capture. */ routes?: string[]; /* The count is a lower bound: the walk it was counted in was cut by the budget. */ truncated?: boolean }>;
  disagreements: Array<{ route: string; mapFiles: string[]; engineFile: string }>;
  omitted: number;
}
