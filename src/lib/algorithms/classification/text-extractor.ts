import {
  ContentObservationSchema,
  type ContentItem,
  type ContentObservation,
  type Scope
} from './content-organization';

export const DETERMINISTIC_TEXT_EXTRACTOR_VERSION = 'deterministic-text-baseline.1';

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
const events = ['毕业', '结婚', '生日', '聚会', '旅行', '退休', '春节', '中秋', '钓鱼', '搬家', '表彰', '入学', '工作', '探亲'];
const people = ['爸爸', '妈妈', '爷爷', '奶奶', '外公', '外婆', '老伴', '儿子', '女儿', '孙子', '孙女', '同学', '战友', '同事'];
const scenes = ['室内', '户外', '家里', '学校', '公园', '车站', '海边', '医院', '办公室'];

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function quoteFor(text: string, value: string): string {
  const index = text.indexOf(value);
  if(index < 0) return value;
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
    const add = (facet: ContentObservation['facet'], value: string, normalizedValue = value) => observations.push(ContentObservationSchema.parse({
      contentId: content.contentId,
      evidenceId,
      facet,
      rawValue: value,
      normalizedValue,
      supports: [{ evidenceId, quote: quoteFor(text, value) }],
      state: 'candidate'
    }));

    for(const year of unique(text.match(/(?:19|20)\d{2}(?=年|\b)/g) ?? [])) add('time', year, year);
    for(const place of places.filter(value => text.includes(value))) add('place', place);
    for(const event of events.filter(value => text.includes(value))) add('event', event);
    for(const person of people.filter(value => text.includes(value))) add('person', person);
    for(const scene of scenes.filter(value => text.includes(value))) add('scene', scene);
    add('content_type', content.modality === 'final_asr' ? '语音转写' : '文字记录');

    return {
      extractorVersion: this.version,
      evidenceStatus: 'deterministic_baseline',
      semanticValidation: 'not_evaluated',
      observations,
      limitations: ['closed_lexicon', 'no_identity_resolution', 'not_a_model_accuracy_result']
    };
  }
}
