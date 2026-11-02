// 中栏底部输入区（2026-11-02 从 StreamView 下沉）。
//
// 承载「提问卡 → 待办坞 → 队列坞 → 输入框」这一串**紧贴输入框**的挂件：
// 它们都必须在输入框同屏（提问要用户现在作答；队列要用户看见还排着几条），
// 且与事件流的滚动/虚拟化无关，故独立成组件。
//
// DOM 契约：本组件用 Fragment 返回**同层兄弟**（不引入额外包裹节点），
// 与下沉前 `.col.center` 下的结构逐字一致。

import * as React from 'react';
import { Composer } from '../Composer.tsx';
import { ChatQueueDock } from '../ChatQueueDock.tsx';
import { QuestionCard } from '../QuestionCard.tsx';
import { TodoDock } from '../TodoDock.tsx';
import { TodoDockModel } from '../../models/TodoDockModel.ts';
import type { StreamViewProps } from '../StreamView.tsx';

/**
 * 中栏底部：待作答提问卡 + 待办坞 + 排队消息坞 + 输入框。
 * @param props StreamView 的入参（整体透传，口径与下沉前相同）
 * @returns 底部挂件（同层兄弟，无额外包裹）
 */
export function StreamBottom(props: StreamViewProps): React.ReactElement {
  return (
    <>
      {props.question == null ||
      props.onAnswerQuestion === undefined ||
      props.onQuestionExpired === undefined ? null : (
        <QuestionCard
          request={props.question}
          onSubmit={props.onAnswerQuestion}
          onExpire={props.onQuestionExpired}
        />
      )}
      <TodoDock items={TodoDockModel.latest(props.events)} />
      {/* 队列模式：排队消息坞（空队列时组件自身返回 null）。 */}
      {props.queue === undefined ? null : <ChatQueueDock queue={props.queue} />}
      <Composer
        model={props.model}
        modelOptions={props.modelOptions}
        providerLabel={props.providerLabel}
        reasoning={props.reasoning}
        reasoningOptions={props.reasoningOptions}
        permission={props.permission}
        threadId={props.threadId}
        seed={props.composerSeed ?? null}
        queue={props.queue}
        onToast={props.onToast}
        onApplyMode={props.onApplyMode}
        onOpenTab={props.onOpenTab}
        onOpenFile={props.onOpenFile}
        onLoadThread={props.onLoadThread}
        onModelChange={props.onModelChange}
        onReasoningChange={props.onReasoningChange}
        onPermissionChange={props.onPermissionChange}
        onSend={props.onSend}
        disabled={props.disabled}
        busy={props.busy}
        activeTool={props.activeTool}
        api={props.api}
        onStop={props.onStop}
      />
    </>
  );
}
