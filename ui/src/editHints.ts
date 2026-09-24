/** Describe the same types accepted by the server; do not invent native property enums. */
export function editHint(key: string, declaredType: string): string {
  const nullable = declaredType.endsWith('?');
  const type = nullable ? declaredType.slice(0, -1) : declaredType;
  const color = type === 'Color' || (/color|tint/i.test(key) && ['String', 'Int', 'Long'].includes(type));
  let hint: string;
  if (color) {
    hint = '颜色：#RRGGBB、#AARRGGBB、0xAARRGGBB 或十进制；8 位颜色的前两位为透明度';
    if (type === 'Color' || type === 'String') hint += '，也支持原生颜色 token';
  } else if (type.startsWith('enum:')) {
    hint = `可选值：${type.slice(5).split(',').join('、')}`;
  } else {
    const hints: Record<string, string> = {
      Boolean: '可选值：true、false',
      Byte: '整数：-128 ～ 127',
      Short: '整数：-32768 ～ 32767',
      Int: '整数：-2147483648 ～ 2147483647',
      Long: '整数：-9007199254740991 ～ 9007199254740991（可无损传输范围）',
      Float: '有限数值，支持小数，例如 12.5；绝对值不超过约 3.4028235e38',
      Double: '有限数值，支持小数，例如 12.5；不支持 NaN 或 Infinity',
      Char: '单个字符，例如 A',
      String: '文本，可直接输入；以双引号开头时按 JSON 字符串解析',
      space: '统一间距：10；或分边：{"top":10,"right":5,"bottom":0,"left":5}，省略的边为 0',
    };
    hint = hints[type] ?? `类型：${type}`;
  }
  return hint + (nullable ? '；支持 null' : '');
}
