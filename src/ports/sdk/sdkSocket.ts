/** SDK 传输插口：文本帧收发 + 生命周期回调（可替换为任意实现）。 */
export interface SdkSocket {
  send(text: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}
