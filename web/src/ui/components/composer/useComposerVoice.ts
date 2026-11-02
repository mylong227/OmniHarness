// 输入区语音输入 hook：Web Speech API 的开关与结果回填（原 Composer 里的 toggleVoice）。
//
// 识别器只存在于 ref 里（不进 state）：onresult/onend/onerror 都是异步回调，
// 状态只保留 `listening` 供麦克风按钮显示；卸载时同步停掉识别器，避免麦克风常亮
// （原 componentWillUnmount 的语义）。

import * as React from 'react';
import {
  SpeechRecognitionFactory,
  SpeechTranscript,
  type SpeechRecognitionLike,
} from '../../models/SpeechRecognitionFactory.ts';
import { growComposerTextarea } from './composerCompletions.ts';

/** 语音输入接口。 */
export interface ComposerVoiceApi {
  /** 是否正在录音（按钮图标 / 文案 / 类名据此切换）。 */
  readonly listening: boolean;
  /** 开始 / 停止语音输入。 */
  readonly toggle: () => void;
}

/**
 * 语音输入：识别结果追加到非受控 textarea 末尾。
 * @param taRef 输入框引用
 * @returns 录音态与开关
 */
export function useComposerVoice(
  taRef: React.RefObject<HTMLTextAreaElement | null>,
): ComposerVoiceApi {
  const [listening, setListening] = React.useState<boolean>(false);
  const recogRef = React.useRef<SpeechRecognitionLike | null>(null);

  // 卸载时停掉可能仍在录的识别器，避免麦克风常亮（原 componentWillUnmount）。
  React.useEffect(() => {
    return () => {
      recogRef.current?.stop();
    };
  }, []);

  /** 开始 / 停止语音输入。 @returns 无 */
  const toggle = (): void => {
    if (listening) {
      recogRef.current?.stop();
      return;
    }
    const recog = SpeechRecognitionFactory.create('zh-CN');
    if (recog === null) return;
    recog.onresult = (e) => {
      const ta = taRef.current;
      if (!ta) return;
      const add = SpeechTranscript.concat(e);
      if (add !== '') {
        ta.value = ta.value === '' ? add : ta.value.replace(/\s*$/, '') + ' ' + add;
        growComposerTextarea(taRef.current);
      }
    };
    recog.onend = () => setListening(false);
    recog.onerror = () => setListening(false);
    recogRef.current = recog;
    setListening(true);
    try {
      recog.start();
    } catch {
      setListening(false);
    }
  };

  return { listening, toggle };
}
