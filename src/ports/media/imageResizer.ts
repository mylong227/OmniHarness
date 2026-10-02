/**
 * 图片缩放端口：把「超大静态图片」收敛到模型上下文可接受的预算内。
 *
 * ## 为什么需要这个端口
 *
 * `view_image` 在零依赖时代对大图只有一条路：**拒绝**（>5 MiB 直接报错，工具注释里明写
 * 「压缩需要图像库，与零依赖冲突」）。现代手机照片 / 截图动辄 3–8 MiB JPEG，全尺寸交给
 * 模型又是一笔巨大的 token 开销——这条能力缺口由第三方图像库（sharp）补上，
 * 但依赖只允许落在适配层，于是工具消费本端口、适配器包 sharp，二者互不认识。
 *
 * ## 契约
 *
 * - 实现**可以不认识**某个输入（解码不了 / 没有缩放能力）：返回 `undefined`，
 *   由调用方走「无缩放」的历史行为（原样交付或按上限拒绝）。**绝不抛错代替 undefined**——
 *   缩放失败应当退化为「不缩放」，而不是把原本能看的图变成报错。
 * - 成功时必须同时交付**编码后字节**与**编码后尺寸**（二者来自同一产物，分开传必然漂移）。
 */

/** 缩放请求：一张已读取的静态图 + 预算约束。 */
export interface ImageResizeRequest {
  /** 图片原始字节。 */
  readonly bytes: Buffer;
  /** 原始 MIME 类型（由探测方给出，如 `image/jpeg`）。 */
  readonly mediaType: string;
  /** 编码后长边上限（像素）。 */
  readonly maxDimension: number;
  /** 编码后单图字节上限。 */
  readonly maxBytes: number;
}

/** 缩放结果：编码产物 + 尺寸 + 是否真的缩小过。 */
export interface ImageResizeOutcome {
  /** 编码后的图片字节（可能是原图原样返回）。 */
  readonly bytes: Buffer;
  /** 编码后的 MIME 类型（格式转换时会与输入不同）。 */
  readonly mediaType: string;
  /** 编码后宽度（像素）。 */
  readonly width: number;
  /** 编码后高度（像素）。 */
  readonly height: number;
  /** 是否发生了缩小 / 转码（供调用方如实告知模型「看到的不是原图」）。 */
  readonly resized: boolean;
}

/**
 * 图片缩放端口。
 *
 * 实现按能力分流：有图像库（sharp）时做解码 → 缩放 → 重编码；
 * 无图像库时返回 `undefined`，调用方退化为历史行为。
 */
export interface ImageResizerPort {
  /** 实现名（用于诊断与错误文案）。 */
  readonly name: string;
  /**
   * 尝试把图片收敛到预算内。
   *
   * @param request 缩放请求（原始字节 + 预算）。
   * @returns 缩放结果；本实现无法处理该输入（解码失败 / 无缩放能力）时为 `undefined`。
   */
  resize(request: ImageResizeRequest): Promise<ImageResizeOutcome | undefined>;
}
