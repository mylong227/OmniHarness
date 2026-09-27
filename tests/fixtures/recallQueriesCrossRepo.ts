/**
 * 跨仓库检索评测查询集（L3 证据层，2026-09-27）。
 *
 * ## 为什么需要它（检索结论升 L3）
 *
 * 仓内既有检索结论（精排 +2.9pp、判别器不改、语义路价值）全部建立在**单一语料**——本仓 `src/`——
 * 之上（L2 证据层）。单语料结论有两个结构性风险：① 语料即被测系统的家，协议与查询同源，有过拟合
 * 嫌疑；② 规模/语言/风格单一。本 fixture 把同一协议复制到 **5 个外部真实仓库**（Python 系，
 * 与本仓 TS 完全异构），使「方向是否跨语料复现」成为可机械验证的问题（L3）。
 *
 * ## 采集协议（与仓内 `recallQueries.ts` 同一套约束，机械校验）
 *
 * 1. **锚点必存在且稀有**：锚点字面量在外部语料中真实出现（GT 非空），且出现文件数 ≤ 3
 *    （过泛锚点把 GT 摊大、命中率被抬成噪声）。候选由 `evals/crossrepo-anchor-probe.mjs` 机械列出。
 * 2. **对抗性**：查询内容词与锚点子词零交集——复用仓内 {@link adversarialOverlap} 单一真相来源。
 * 3. **路径词禁令**：查询内容词不得命中任何 GT 文件名的词干（防「答案写在查询里」）。
 * 4. **语料口径**：只索引各仓库的**可导入包源码目录**（不含测试/文档），与本仓「只索引 src/」对齐。
 *    1–4 条约束由 `evals/recall-crossrepo.mjs` 在真实语料上 fail-closed 校验；其中 2 与「查询不得含
 *    包目录名/仓名词元」的离线代理另有单测（`tests/unit/recallQueriesCrossRepo.test.ts`，零语料依赖，
 *    可在 CI 当门禁）——1、3 两条必须读语料，故留在仪器里。
 *
 * ## 诚实边界
 *
 * 外部仓库为 Python 代码，查询由模型按公开文档知识撰写、逐条经机械协议校验（GT / 稀有性 /
 * 对抗性 / 路径词），**未经第二方独立复核**（与仓内 193 条的流程差异如实登记）。
 * 语料目录 `eval-data/` 整目录不入库（`.gitignore`）⇒ 依赖语料的校验只在语料就位的机器上可跑。
 */

/** 一条跨仓库检索评测查询（与仓内 `RecallQuery` 同形）。 */
export interface CrossRepoQuery {
  readonly q: string;
  readonly anchor: string;
}

/** 一个外部语料：仓库标识 + 包源码目录（相对仓根）+ 该语料的查询集。 */
export interface CrossRepoCorpus {
  readonly repo: string;
  readonly root: string;
  readonly queries: readonly CrossRepoQuery[];
}

/** pallets/flask：WSGI 微框架（24 文件）。 */
export const FLASK_QUERIES: readonly CrossRepoQuery[] = [
  {
    q: "how a visitor's identity is remembered between round trips via a signed browser blob",
    anchor: 'SecureCookieSessionInterface',
  },
  {
    q: 'what lets a background thread reuse the inbound HTTP data inside a worker pool',
    anchor: 'copy_current_request_context',
  },
  {
    q: 'which knob decides how long the remember-me blob stays valid',
    anchor: 'PERMANENT_SESSION_LIFETIME',
  },
  {
    q: 'where template lookup is wired to the bundled view sources',
    anchor: 'create_global_jinja_loader',
  },
  {
    q: 'what gets sent back automatically when a client asks which verbs an endpoint accepts',
    anchor: 'make_default_options_response',
  },
  {
    q: 'diagnostic that reports every location tried while hunting for a missing view file',
    anchor: 'explain_template_loading_attempts',
  },
  {
    q: 'how form data is preserved when a file upload field failed validation and the page re-renders',
    anchor: 'attach_enctype_error_multidict',
  },
  {
    q: 'when a relative redirect target is rewritten to an absolute address',
    anchor: 'autocorrect_location_header',
  },
  {
    q: "whether the login blob's expiry clock resets on every call",
    anchor: 'SESSION_REFRESH_EACH_REQUEST',
  },
  {
    q: 'how long browsers are told to keep static assets without re-fetching',
    anchor: 'SEND_FILE_MAX_AGE_DEFAULT',
  },
  {
    q: 'hook that runs exactly once when the initial caller arrives',
    anchor: 'BeforeFirstRequestCallable',
  },
  {
    q: 'which flag opts the login blob into being scoped per top-level site',
    anchor: 'SESSION_COOKIE_PARTITIONED',
  },
];

/** psf/requests：HTTP 客户端库（18 文件）。 */
export const REQUESTS_QUERIES: readonly CrossRepoQuery[] = [
  {
    q: 'how downloaded bytes become text piece by piece while iterating',
    anchor: 'stream_decode_response_unicode',
  },
  {
    q: 'how per-call trust store and proxy configuration picks up what the operating system declares',
    anchor: 'merge_environment_settings',
  },
  {
    q: 'how the character set of a downloaded payload is inferred when the server announces it',
    anchor: 'get_encoding_from_headers',
  },
  {
    q: 'how file uploads are serialized for the wire',
    anchor: 'encode_multipart_formdata',
  },
  {
    q: 'where proxy URLs gain a protocol prefix they were missing',
    anchor: 'prepend_scheme_if_needed',
  },
  {
    q: 'how a host is judged exempt from proxying according to OS variables',
    anchor: 'proxy_bypass_environment',
  },
  {
    q: 'what alert category fires on an incompatible underlying http library version',
    anchor: 'RequestsDependencyWarning',
  },
  {
    q: 'how the media designation and its parameters are pulled out of the payload descriptor',
    anchor: '_parse_content_type_header',
  },
  {
    q: 'how the target address is reworked so it flows through a configured middleman',
    anchor: 'rebuild_proxies',
  },
  {
    q: 'how resources bundled inside an egg archive are made readable',
    anchor: 'extract_zipped_paths',
  },
  {
    q: 'what diagnostic bundle describes the outgoing call for support dumps',
    anchor: '_urllib3_request_context',
  },
  {
    q: 'where the list of trusted certificate authorities comes from by default',
    anchor: 'DEFAULT_CA_BUNDLE_PATH',
  },
];

/** pytest-dev/pytest：测试框架（77 文件）。 */
export const PYTEST_QUERIES: readonly CrossRepoQuery[] = [
  {
    q: 'how a stale filesystem guard from a crashed run is judged expired during cleanup',
    anchor: 'consider_lock_dead_if_created_before',
  },
  {
    q: 'what happens when a table-driven case list assigns the same argument name twice',
    anchor: '_complain_multiple_hidden_parameter_sets',
  },
  {
    q: 'knob limiting the printed output of a broken example block to its initial problem',
    anchor: 'DOCTEST_REPORT_CHOICE_ONLY_FIRST_FAILURE',
  },
  {
    q: 'what is laid down on disk the first time last-failed records need a home',
    anchor: '_ensure_cache_dir_and_supporting_files',
  },
  {
    q: 'environment switch restoring older import handling for distribute-style finders',
    anchor: 'MONKEYPATCH_LEGACY_NAMESPACE_PACKAGES',
  },
  {
    q: 'which caution category covers a background worker blowing up with nothing catching it',
    anchor: 'PytestUnhandledThreadExceptionWarning',
  },
  {
    q: 'what pads the remaining width of the status line while a session runs',
    anchor: '_write_progress_information_filling_space',
  },
  {
    q: "how the stack shown when a package's initialization file cannot load gets trimmed",
    anchor: 'filter_traceback_for_conftest_import_failure',
  },
  {
    q: 'where old xUnit group-level preparation becomes a hook-based provider',
    anchor: '_register_unittest_setup_class_fixture',
  },
  {
    q: 'why a caution fires when a custom node subclasses both the leaf and the container',
    anchor: '_check_item_and_collector_diamond_inheritance',
  },
  {
    q: "how the summary extracts the short reason next to an error's location marker",
    anchor: '_get_line_with_reprcrash_message',
  },
  {
    q: 'which switch makes a hung run terminate the whole process after a deadline',
    anchor: 'get_exit_on_timeout_config_value',
  },
];

/** sphinx-doc/sphinx：文档生成器（385 文件）。 */
export const SPHINX_QUERIES: readonly CrossRepoQuery[] = [
  {
    q: 'setting controlling whether cross-links inside Google-style prose become boxed callouts',
    anchor: 'napoleon_use_admonition_for_references',
  },
  {
    q: 'how the docs find members that only exist after first use but were never declared in the class body',
    anchor: 'UninitializedInstanceAttributeMixin',
  },
  {
    q: 'builder switch deciding that slow external references are marked dead rather than ignored',
    anchor: 'linkcheck_report_timeouts_as_broken',
  },
  {
    q: 'knob choosing where in the generated page the annotation prose of a callable lands',
    anchor: 'autodoc_typehints_description_target',
  },
  {
    q: 'whether sample blocks in Google-style docstrings render as boxed callouts',
    anchor: 'napoleon_use_admonition_for_examples',
  },
  {
    q: 'how declared members recover richer call shapes from inline remarks in their source',
    anchor: '_update_module_annotations_from_type_comments',
  },
  {
    q: 'checking whether a markup fragment sits inside a reusable inline replacement block',
    anchor: '_is_node_in_substitution_definition',
  },
  {
    q: 'validation of the pattern list that whitelists specific external hop chains',
    anchor: 'compile_linkcheck_allowed_redirects',
  },
  {
    q: 'lookup helper matching an explicit identifier to the exact documented object across namespaces',
    anchor: '_resolve_reference_in_domain_by_target',
  },
  {
    q: 'helper letting suite authors reuse an already built site without rebuilding',
    anchor: 'SphinxTestAppWrapperForSkipBuilding',
  },
  {
    q: 'distinguishing authored callables from library-provided ones when documenting members',
    anchor: 'get_user_defined_function_or_method',
  },
  {
    q: 'JS domain knob controlling whether generated callables tolerate dangling separators',
    anchor: 'javascript_trailing_comma_in_multi_line_signatures',
  },
];

/** django/django：Web 全栈框架（993 文件，L3 语料的主力大仓）。 */
export const DJANGO_QUERIES: readonly CrossRepoQuery[] = [
  {
    q: 'where asynchronous credential verification sleeps on purpose to blunt stopwatch oracles',
    anchor: 'check_password_with_timing_attack_mitigation',
  },
  {
    q: 'how an atomic block copes when the driver reports auto-commit support that does not actually work',
    anchor: 'force_begin_transaction_with_broken_autocommit',
  },
  {
    q: 'which database backends accept an index that must be singular yet may ignore empty values',
    anchor: 'supports_partially_nullable_unique_constraints',
  },
  {
    q: 'which engines need the query author to spell out where sorted empties land when collapsing rows',
    anchor: 'requires_explicit_null_ordering_when_grouping',
  },
  {
    q: 'lookup that tests whether an array inside a document field holds a given element',
    anchor: 'json_key_contains_list_matching_requires_list',
  },
  {
    q: "decorator keeping async handlers from leaking secrets through the debugger's local dump",
    anchor: 'coroutine_functions_to_sensitive_variables',
  },
  {
    q: 'why saving a string with embedded zero bytes is rejected',
    anchor: 'prohibits_null_characters_in_text_exception',
  },
  {
    q: 'validation that flags annotation misuse inside meta-level sort directives on a model class',
    anchor: '_check_ordering_first_last_queryset_aggregation',
  },
  {
    q: 'notice emitted when an old seasoning value still guards the browser token',
    anchor: 'SIGNED_COOKIE_LEGACY_SALT_DEPRECATED_MSG',
  },
  {
    q: "upper bound that keeps auto-created access labels inside the column's character budget",
    anchor: 'max_builtin_permission_codename_length',
  },
  {
    q: 'migration writer emitting the change that repositions a model relative to its parent',
    anchor: 'generate_altered_order_with_respect_to',
  },
  {
    q: 'setting verifier ensuring a value is a sequence of whole numbers split by punctuation',
    anchor: 'validate_comma_separated_integer_list',
  },
];

/** 全部外部语料（顺序即报告呈现顺序）。 */
export const CROSS_REPO_CORPORA: readonly CrossRepoCorpus[] = [
  {
    repo: 'pallets/flask',
    root: 'eval-data/repos/pallets__flask/src/flask',
    queries: FLASK_QUERIES,
  },
  {
    repo: 'psf/requests',
    root: 'eval-data/repos/psf__requests/src/requests',
    queries: REQUESTS_QUERIES,
  },
  {
    repo: 'pytest-dev/pytest',
    root: 'eval-data/repos/pytest-dev__pytest/src/_pytest',
    queries: PYTEST_QUERIES,
  },
  { repo: 'django/django', root: 'eval-data/repos/django__django/django', queries: DJANGO_QUERIES },
  {
    repo: 'sphinx-doc/sphinx',
    root: 'eval-data/repos/sphinx-doc__sphinx/sphinx',
    queries: SPHINX_QUERIES,
  },
];
