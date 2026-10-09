import { useEffect, useState } from "react";

import {
  loadSharedExtensionSettings,
  onSharedExtensionSettingsSaved,
  saveSharedExtensionSettings,
} from "../extension-settings";

// 高级模式（spec 4.3）：用户级开关，只改变诊断入口的可见性（提示词预览等），
// 不改变聊天行为与已保存数据。默认关闭（简单模式）。
// 与界面语言共用 __mycompanion_preferences 存储域。
export function useAdvancedMode(): { advancedMode: boolean; setAdvancedMode: (value: boolean) => void } {
  const [advancedMode, setAdvancedModeState] = useState(false);
  useEffect(() => {
    let alive = true;
    const sync = (): void => {
      void loadSharedExtensionSettings().then(settings => {
        if (!alive) return;
        const preferences = settings.__mycompanion_preferences as { advancedMode?: unknown } | undefined;
        setAdvancedModeState(preferences?.advancedMode === true);
      }).catch(() => { /* 读取失败保持关闭，下次保存时重写 */ });
    };
    sync();
    const unsubscribe = onSharedExtensionSettingsSaved(sync);
    return () => { alive = false; unsubscribe(); };
  }, []);
  const setAdvancedMode = (value: boolean): void => {
    // 先乐观更新本地，保存结果回来后由 listener 再对齐一次。
    setAdvancedModeState(value);
    void loadSharedExtensionSettings().then(settings => {
      const preferences = settings.__mycompanion_preferences ??= {};
      (preferences as Record<string, unknown>).advancedMode = value;
      return saveSharedExtensionSettings();
    }).catch(() => { /* 下次写入会重试 */ });
  };
  return { advancedMode, setAdvancedMode };
}
