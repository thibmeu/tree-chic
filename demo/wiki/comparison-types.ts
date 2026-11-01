export interface ComparisonLayout {
  name: string;
  root: string;
  fanout: number;
  capacity: number;
  leafCount: number;
  size: number;
  headerSize: number;
  headerBase64: string;
}

export interface ComparisonRead {
  round: number;
  kind: 'bootstrap' | 'proof' | 'payload';
  start: number;
  end: number;
  bytes: number;
}
