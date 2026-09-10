// 语音识别（Web Speech API）的最小结构封装。
// 只声明用到的字段（避免 any）；不支持的环境由工厂返回 null，调用方 fail-closed 隐藏入口。

/** 识别候选。 */
export interface SpeechAlternativeLike {
  transcript: string;
}
/** 单条识别结果。 */
export interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternativeLike | undefined;
}
/** onresult 事件。 */
export interface SpeechEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechResultLike | undefined };
}
/** 识别器实例（本应用只用到这 8 个成员）。 */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

/** 识别器构造函数签名。 */
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** 识别结果提取器：把事件里的 final 片段拼成一段文本。 */
export class SpeechTranscript {
  /** 只取 isFinal 的结果，避免把中间态反复追加进输入框。 */
  static concat(e: SpeechEventLike): string {
    let add = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res !== undefined && res.isFinal) add += res[0]?.transcript ?? '';
    }
    return add;
  }
}

/** 语音识别工厂。 */
export class SpeechRecognitionFactory {
  /** 取构造函数：标准名优先，webkit 前缀兜底；两者皆无返回 null（环境不支持）。 */
  static ctor(): SpeechRecognitionCtor | null {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  }

  /** 是否支持语音输入（UI 据此决定是否渲染麦克风按钮）。 */
  static supported(): boolean {
    return SpeechRecognitionFactory.ctor() !== null;
  }

  /** 创建并配置一个中文连续识别器；环境不支持时返回 null。 */
  static create(lang = 'zh-CN'): SpeechRecognitionLike | null {
    const Ctor = SpeechRecognitionFactory.ctor();
    if (Ctor === null) return null;
    const recog = new Ctor();
    recog.lang = lang;
    recog.continuous = true;
    recog.interimResults = false;
    return recog;
  }
}
