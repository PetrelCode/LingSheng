/**
 * 中文播报文本归一化。
 *
 * 讯飞离线引擎本身能读数字，但单位、日期、百分号的读法各音色并不完全一致，
 * 这里在送合成前把「3号库房 25.5℃」这类文本转成「三号库房 二十五点五摄氏度」，
 * 与引擎无关，纯字符串规则，便于替换引擎时复用。
 *
 * 注意：多音字不在这里处理。同一汉字的不同读音无法通过字符替换修正，
 * 需要带拼音标注的词典，交给模型自带的 lexicon/jieba 分词处理。
 */

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_UNITS = ['', '十', '百', '千'];

/** 单位读音表，按长度降序匹配，避免 km 抢在 km/h 前面 */
const UNIT_READINGS: Array<[string, string]> = [
  ['km/h', '千米每小时'],
  ['m/s', '米每秒'],
  ['°C', '摄氏度'],
  ['℃', '摄氏度'],
  ['km', '公里'],
  ['cm', '厘米'],
  ['mm', '毫米'],
  ['mL', '毫升'],
  ['ml', '毫升'],
  ['kg', '千克'],
  ['mg', '毫克'],
  ['Hz', '赫兹'],
  ['dB', '分贝'],
  ['L', '升'],
  ['V', '伏'],
  ['A', '安'],
  ['W', '瓦'],
  ['g', '克'],
  ['t', '吨'],
];

/**
 * 全角转半角：只转数字、字母与会被规则匹配的符号。
 * 中文标点（，。；：！？）保持原样，合成时的停顿更自然。
 */
export function toHalfWidth(input: string): string {
  return input
    .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uFF05/g, '%')
    .replace(/\uFF0D/g, '-')
    .replace(/\uFF0B/g, '+')
    .replace(/\uFF0E/g, '.')
    .replace(/\uFF1D/g, '=')
    .replace(/\u3000/g, ' ');
}

/** 逐位读，用于电话、编号、年份 */
export function digitsToCn(digits: string): string {
  return [...digits]
    .map((ch) => (/[0-9]/.test(ch) ? CN_DIGITS[Number(ch)] : ch))
    .join('');
}

function int4(s: string): string {
  const digits = s.replace(/^0+(?=\d)/, '');
  if (!digits || digits === '0') return '';
  let out = '';
  let zero = false;
  for (let i = 0; i < digits.length; i += 1) {
    const d = Number(digits[i]);
    const unit = CN_UNITS[digits.length - 1 - i] ?? '';
    if (d === 0) {
      zero = true;
      continue;
    }
    if (zero && out) out += '零';
    zero = false;
    out += CN_DIGITS[d] + unit;
  }
  if (out.startsWith('一十')) out = out.slice(1);
  return out;
}

function belowYi(s: string): string {
  const digits = s.replace(/^0+(?=\d)/, '');
  if (!digits || digits === '0') return '';
  if (digits.length <= 4) return int4(digits);
  const wan = digits.slice(0, digits.length - 4);
  const ge = digits.slice(-4);
  let out = `${int4(wan)}万`;
  const geText = int4(ge);
  if (geText) out += (ge.startsWith('0') ? '零' : '') + geText;
  return out;
}

/** 整数转中文读法，超出 12 位按位读 */
export function intToCn(value: string): string {
  const digits = value.replace(/^0+(?=\d)/, '');
  if (digits === '0') return '零';
  if (digits.length > 12) return digitsToCn(digits);
  if (digits.length <= 8) return belowYi(digits);
  const yi = digits.slice(0, digits.length - 8);
  const rest = digits.slice(-8);
  let out = `${intToCn(yi)}亿`;
  const restText = belowYi(rest);
  if (restText) out += (rest.startsWith('0') ? '零' : '') + restText;
  return out;
}

/**
 * 数字串读法：
 * - 小数：二十五点五
 * - 7 位以上纯整数（电话、编号）：逐位读
 * - 其余：数值读法
 */
export function numberToCn(raw: string): string {
  const negative = raw.startsWith('-');
  const body = raw.replace(/^[-+]/, '');
  const [intPart, decPart] = body.split('.');
  const intDigits = intPart || '0';
  let out = negative ? '负' : '';
  if (decPart !== undefined) {
    out += intToCn(intDigits) + '点' + digitsToCn(decPart);
    return out;
  }
  if (intDigits.length >= 7) return out + digitsToCn(intDigits);
  return out + intToCn(intDigits);
}

function applyUnits(text: string): string {
  const units = UNIT_READINGS.map(([k]) => k.replace(/[/]/g, '\\/')).join('|');
  const pattern = new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*(${units}|%|m(?![A-Za-z]))?`, 'g');
  return text.replace(pattern, (match, num: string, unit: string | undefined) => {
    if (unit === '%') return `百分之${numberToCn(num.replace(/^-/, ''))}`;
    if (unit === '°C' || unit === '℃') {
      return `${num.startsWith('-') ? '零下' : ''}${numberToCn(num.replace(/^-/, ''))}摄氏度`;
    }
    const reading = UNIT_READINGS.find(([k]) => k === unit)?.[1] ?? (unit === 'm' ? '米' : '');
    return numberToCn(num) + reading;
  });
}

/**
 * 把播报文本转成适合合成的口语化文本。
 */
export function normalizeText(input: string): string {
  let text = toHalfWidth(String(input ?? ''))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ');

  // 日期：2026-11-04 / 2026/11/4 / 2026年11月4日
  text = text.replace(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/g, (_m, y: string, mo: string, d: string) => {
    return `${digitsToCn(y)}年${intToCn(mo)}月${intToCn(d)}日`;
  });

  // 时间：8:30 / 08:30:15
  text = text.replace(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g, (_m, h: string, mi: string, s?: string) => {
    return `${intToCn(h)}点${intToCn(mi)}分${s ? intToCn(s) + '秒' : ''}`;
  });

  // 年份：2026年（单独出现时逐位读）
  text = text.replace(/(\d{4})\s*年/g, (_m, y: string) => `${digitsToCn(y)}年`);

  // 区间：3~5 / 3-5 / 3 至 5（前后都是数字才算）
  text = text.replace(/(-?\d+(?:\.\d+)?)\s*(?:[~～]|—|－)\s*(-?\d+(?:\.\d+)?)/g, '$1到$2');

  text = applyUnits(text);

  // 残留符号
  text = text
    .replace(/×/g, '乘')
    .replace(/÷/g, '除以')
    .replace(/=/g, '等于')
    .replace(/\+/g, '加')
    .replace(/&/g, '和')
    .replace(/°/g, '度');

  // 半角标点转中文标点，合成时的停顿更自然
  text = text
    .replace(/,/g, '，')
    .replace(/;/g, '；')
    .replace(/:/g, '：')
    .replace(/!/g, '！')
    .replace(/\?/g, '？')
    .replace(/\./g, '。')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();

  return text;
}

/**
 * 按标点把文本切成不超过 maxChars 的段。
 * 多段会分别合成，作为多个 URL 一次性下发给设备顺序播放。
 */
export function splitText(text: string, maxChars: number): string[] {
  const source = text.trim();
  if (!source) return [];
  if (source.length <= maxChars) return [source];

  const limit = Math.max(20, maxChars);
  const out: string[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) out.push(buffer.trim());
    buffer = '';
  };

  for (const sentence of source.split(/(?<=[。！？!?；;\n])/)) {
    const piece = sentence.trim();
    if (!piece) continue;
    if ((buffer + piece).length <= limit) {
      buffer += piece;
      continue;
    }
    flush();
    if (piece.length <= limit) {
      buffer = piece;
      continue;
    }
    for (const part of piece.split(/(?<=[，,、：:])/)) {
      const seg = part.trim();
      if (!seg) continue;
      if ((buffer + seg).length <= limit) {
        buffer += seg;
        continue;
      }
      flush();
      if (seg.length <= limit) {
        buffer = seg;
        continue;
      }
      for (let i = 0; i < seg.length; i += limit) {
        const cut = seg.slice(i, i + limit);
        if (i + limit < seg.length) out.push(cut);
        else buffer = cut;
      }
    }
  }
  flush();
  return out;
}
