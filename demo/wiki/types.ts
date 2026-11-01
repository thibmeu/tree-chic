export interface Article {
  start: number;
  end: number;
  id: string;
  title: string;
}

export interface Manifest {
  format: string;
  coverage: string;
  source: string;
  sourceSize: number;
  root: string;
  size: number;
  chunk: number;
  leaves: number;
  headerSize: number;
  articles: Article[];
}

export type Transport = (url: string, options?: RequestInit) => Promise<Response>;

export interface RangeTrace {
  kind: 'bootstrap' | 'proof' | 'payload';
  start: number;
  end: number;
  bytes: number;
}
