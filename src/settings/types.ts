export type SettingType =
  | 'boolean' | 'integer' | 'number' | 'string' | 'color' | 'rgba' | 'point' | 'point3'
  | 'string[]' | 'datetime' | 'aggregate';

export type PostLoadRule =
  | 'min2' | 'iemHttps' | 'abs' | 'min0.15' | 'min5' | 'parseDateOr0' | 'l3Index' | 'derivedSiteIdx'
  | 'videoHeightFromScreen' | 'consumerHailReset' | 'loopMax6' | 'bits18' | 'coFamily' | 'clamp1to20';

export interface SettingDef {
  id: string;
  scope: string;
  /** Owner record: CWRV3Settings (main document), CWRV3ConfigurationSettings (+ sub-records) or LayerState. */
  owner: string | null;
  type: SettingType;
  storage: string | null;
  section: string | null;
  key: string | null;
  default: unknown;
  min: number | null;
  max: number | null;
  enum: number[] | null;
  postLoad: PostLoadRule | null;
  ui: string[];
  label: string;
  /** Read-only migration input (legacy layer-state keys): read when present, never written. */
  legacy?: boolean;
  /** Per-element INI keys of an array setting. */
  elements?: string[];
}
