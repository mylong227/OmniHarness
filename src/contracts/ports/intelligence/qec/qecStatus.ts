/** QEC 校验状态：ok=正常 / corrected=已纠正 / uncorrectable=无法定位纠正（多点 corrupt，fail-closed）。 */
export type QECStatus = 'ok' | 'corrected' | 'uncorrectable';
