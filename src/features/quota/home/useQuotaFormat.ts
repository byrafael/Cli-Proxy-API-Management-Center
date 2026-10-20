import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PROVIDER_LABEL,
  displayEmail,
  formatAbsolute,
  formatCountdown,
  type AccountGroup,
  type AccountStatus,
  type CountdownUnits,
  type GroupBy,
} from './model';

const NS = 'quota_management.home';

/** 把 model 里的纯格式化函数绑定到当前界面语言。 */
export function useQuotaFormat() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;

  return useMemo(() => {
    const units: CountdownUnits = {
      now: t(`${NS}.unit_now`),
      d: t(`${NS}.unit_d`),
      h: t(`${NS}.unit_h`),
      m: t(`${NS}.unit_m`),
    };
    const countdown = (ms: number) => formatCountdown(ms, units);
    return {
      t,
      countdown,
      absolute: (ts: number) => formatAbsolute(ts, language),
      /** "in 3d 4h" / "2h ago"；一分钟内算 just now。 */
      relative: (ts: number, now: number) => {
        const delta = ts - now;
        if (Math.abs(delta) < 60_000) return t(`${NS}.just_now`);
        return delta > 0
          ? t(`${NS}.in_time`, { time: countdown(delta) })
          : t(`${NS}.ago`, { time: countdown(-delta) });
      },
      statusLabel: (status: AccountStatus) => t(`${NS}.status_${status}`),
      /** 分组标题：提供商是品牌名不翻译，其余按语言生成；邮箱按脱敏开关处理。 */
      groupTitle: (group: AccountGroup, by: GroupBy, redact: boolean) => {
        if (by === 'provider' && group.provider) return PROVIDER_LABEL[group.provider];
        if (by === 'plan') return t(`${NS}.tier_${group.key}`);
        if (by === 'status') return t(`${NS}.status_${group.key}`);
        if (by === 'email') {
          return group.email ? displayEmail(group.email, redact) : t(`${NS}.no_email`);
        }
        return t(`${NS}.all_accounts`);
      },
    };
  }, [t, language]);
}
