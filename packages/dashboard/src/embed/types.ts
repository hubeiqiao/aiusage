export type EmbedWidget =
  | 'stats-row1'
  | 'stats-row2'
  | 'cost-trend'
  | 'token-trend'
  | 'token-composition'
  | 'flow'
  | 'share';

export type EmbedTheme = 'light' | 'dark' | 'auto';

export interface EmbedParams {
  widget: EmbedWidget | null;
  items: number[] | null;       // null = show all
  range: string;
  theme: EmbedTheme;
  transparent: boolean;
  locale: 'en' | 'zh';
  deviceId: string;
  product: string;
}
