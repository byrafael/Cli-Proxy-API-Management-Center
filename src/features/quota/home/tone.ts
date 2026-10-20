import type { Tone } from './model';
import styles from './shared.module.scss';

const toneClass: Record<Tone, string> = {
  high: styles.toneHigh,
  medium: styles.toneMedium,
  low: styles.toneLow,
  none: styles.toneNone,
};

/** 设置 `--tone` 自定义属性的类名；水位条 / 环 / 徽章都读它着色。 */
export const toneClassFor = (tone: Tone): string => toneClass[tone];
