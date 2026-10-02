import {
  ContentObservationSchema,
  type ContentItem,
  type ContentObservation,
  type Scope
} from './content-organization';

export const DETERMINISTIC_TEXT_EXTRACTOR_VERSION = 'deterministic-text-baseline.4';

export interface TextExtractionRequest {
  scope: Scope;
  content: ContentItem;
  taxonomyVersion: string;
}

export interface TextExtractionResult {
  extractorVersion: string;
  evidenceStatus: 'deterministic_baseline';
  semanticValidation: 'not_evaluated';
  observations: ContentObservation[];
  limitations: string[];
}

export interface TextContentExtractor {
  readonly version: string;
  extract(input: TextExtractionRequest): TextExtractionResult | Promise<TextExtractionResult>;
}

const places = ['北京', '上海', '广州', '深圳', '武汉', '成都', '重庆', '西安', '杭州', '南京', '苏州', '天津', '长沙', '青岛', '厦门', '香港', '澳门'];
const people = ['爸爸', '妈妈', '爷爷', '奶奶', '外公', '外婆', '老伴', '儿子', '女儿', '孙子', '孙女', '同学', '战友', '同事'];
const scenes = ['室内', '户外', '家里', '学校', '公园', '车站', '海边', '医院', '办公室'];
const chineseDigits: Record<string, string> = { '〇': '0', '零': '0', '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };

function chineseYear(token: string): string | undefined {
  const digits = [...token].map(value => chineseDigits[value]).join('');
  if(!/^\d{2}$|^\d{4}$/.test(digits)) return undefined;
  if(digits.length === 4) return digits;
  const value = Number(digits);
  return `${(value >= 30 ? 1900 : 2000) + value}`;
}

function yearSignalsFrom(text: string): { candidate: string[]; conflicted: string[] } {
  const arabic = text.match(/(?:19|20)\d{2}(?=年|\b)/g) ?? [];
  const chinese = [...text.matchAll(/([〇零一二三四五六七八九]{2}|[〇零一二三四五六七八九]{4})年/g)]
    .map(match => chineseYear(match[1])).filter((value): value is string => Boolean(value));
  const values = unique([...arabic, ...chinese]);
  const correction = text.match(/(?:不对|不是).{0,12}?(?:应该是|是)([〇零一二三四五六七八九]{2,4}|(?:19|20)\d{2})年/);
  if(!correction) return { candidate: values, conflicted: [] };
  const corrected = /^\d/.test(correction[1]) ? correction[1] : chineseYear(correction[1]);
  return corrected
    ? { candidate: [corrected], conflicted: values.filter(value => value !== corrected) }
    : { candidate: values, conflicted: [] };
}

const eventRules: Array<[string, RegExp]> = [
  ['毕业', /毕业/], ['求学', /夜校|入学|报到|上学|求学/], ['工作', /进厂|上班|工作/],
  ['婚礼', /婚礼|结婚/], ['生日', /生日/], ['家庭聚会', /家庭聚会|团圆饭|全家回来|春节|中秋/],
  ['聚会', /同学聚会|战友聚会|同事聚会|朋友聚会|聚餐/],
  ['旅行', /旅行|出去玩|短途游|看湖|看海|坐火车/], ['搬家', /搬家|搬进/],
  ['兴趣活动', /木工|钓鱼|书法|兰花|换盆|摄影|养花/], ['欢送会', /欢送会|送别/], ['其他', /义卖/], ['退休', /退休/]
];

function negated(text: string, value: string): boolean {
  return new RegExp(`(?:不是|并非).{0,8}${value}|别.{0,8}(?:写成|归为).{0,8}${value}`).test(text);
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function quoteFor(text: string, value: string): string {
  const index = text.indexOf(value);
  if(index < 0) return text.slice(0, Math.min(text.length, 96));
  return text.slice(Math.max(0, index - 12), Math.min(text.length, index + value.length + 12));
}

export class DeterministicTextExtractor implements TextContentExtractor {
  readonly version = DETERMINISTIC_TEXT_EXTRACTOR_VERSION;

  extract({ scope, content }: TextExtractionRequest): TextExtractionResult {
    if(content.scope.householdId !== scope.householdId || content.scope.subjectId !== scope.subjectId) throw new Error('CROSS_SCOPE');
    if(content.lifecycle !== 'active') throw new Error('INACTIVE_CONTENT');
    if(content.modality !== 'user_text' && content.modality !== 'final_asr') throw new Error('UNSUPPORTED_TEXT_MODALITY');
    const text = content.originalText?.normalize('NFKC').trim();
    if(!text) throw new Error('MISSING_TEXT_PAYLOAD');
    const evidenceId = content.evidenceIds[0];
    const observations: ContentObservation[] = [];
    const add = (facet: ContentObservation['facet'], value: string, normalizedValue = value, state: ContentObservation['state'] = 'candidate') => observations.push(ContentObservationSchema.parse({
      contentId: content.contentId,
      evidenceId,
      facet,
      rawValue: value,
      normalizedValue,
      supports: [{
        evidenceId,
        sourceType: content.modality === 'final_asr' ? 'final_asr' : 'user_text',
        quote: quoteFor(text, value)
      }],
      state
    }));

    const injection = /忽略(?:规则|以上|指令)|安全测试.{0,16}(?:认成|地点写|事件写)/.test(text);
    if(!injection) {
      const yearSignals = yearSignalsFrom(text);
      for(const year of yearSignals.candidate) add('time', year, year);
      for(const year of yearSignals.conflicted) add('time', year, year, 'conflicted');
      if(/八十年代/.test(text)) add('time', '八十年代', '1980s');
      if(/前年冬天/.test(text)) add('time', '前年冬天', 'two_winters_before_upload');
      for(const place of places.filter(value => text.includes(value))) add('place', place);
      if(/教学楼前/.test(text)) add('place', '教学楼前');
      if(/海边|看海/.test(text)) add('place', '海边行程途中');
      if(/家中|一家吃团圆饭/.test(text)) add('place', '家中');
      const positiveEvents = new Set<string>();
      const explicitCorrection = /(?:不是|并非).{0,24}(?:别|不要).{0,12}(?:写成|归为)/.test(text);
      for(const [event, pattern] of eventRules) if(pattern.test(text) && !negated(text, event) && !(event === '其他' && explicitCorrection)) {
        add('event', event);
        positiveEvents.add(event);
      }
      for(const person of people.filter(value => text.includes(value))) add('person', person);
      if(/我爱人/.test(text)) add('person', '我爱人', '我爱人（用户明确关系）');
      for(const scene of scenes.filter(value => text.includes(value))) add('scene', scene);
      if(/团圆|全家/.test(text)) { add('theme', '团聚'); add('theme', '家庭'); }
      if(/旅行|短途游|古镇|看海|看湖/.test(text)) add('theme', '旅行');
      if(/古镇/.test(text)) add('theme', '古镇');
      if(positiveEvents.has('毕业')) { add('theme', '求学'); add('theme', '毕业'); }
      if(positiveEvents.has('婚礼')) { add('theme', '婚礼'); add('theme', '人生里程碑'); }
    }
    add('content_type', content.modality === 'final_asr' ? '语音转写' : '文字记录');

    return {
      extractorVersion: this.version,
      evidenceStatus: 'deterministic_baseline',
      semanticValidation: 'not_evaluated',
      observations,
      limitations: ['closed_lexicon', 'no_identity_resolution', ...(injection ? ['prompt_injection_ignored'] : []), 'not_a_model_accuracy_result']
    };
  }
}
