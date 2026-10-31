import type { EmbeddingsProvider, EmbeddingOptions } from '../../ports/embeddings.js';

const MODEL = 'Xenova/multilingual-e5-small';
const DIMENSIONS = 384;
const BATCH_SIZE = 16;

type PipelineOptions = { dtype: 'q8'; cacheDir?: string };
type ExtractionOptions = { pooling: 'mean'; normalize: true };
type FeatureTensor = { tolist(): unknown };
type FeaturePipeline = (texts: string[], options: ExtractionOptions) => Promise<FeatureTensor>;
type PipelineLoader = (model: string, options: PipelineOptions) => Promise<FeaturePipeline>;

async function loadPipeline(model: string, options: PipelineOptions): Promise<FeaturePipeline> {
  const { env, pipeline } = await import('@huggingface/transformers');
  if (options.cacheDir !== undefined) env.cacheDir = options.cacheDir;
  const extractor = await pipeline('feature-extraction', model, { dtype: options.dtype });
  return async (texts, extractionOptions) =>
    (await extractor(texts, extractionOptions)) as unknown as FeatureTensor;
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

export function createLocalEmbeddingsProvider(options: {
  cacheDir?: string;
  loadPipeline?: PipelineLoader;
} = {}): EmbeddingsProvider {
  let pipelinePromise: Promise<FeaturePipeline> | undefined;
  const loader = options.loadPipeline ?? loadPipeline;
  const getPipeline = (): Promise<FeaturePipeline> => {
    pipelinePromise ??= loader(MODEL, {
      dtype: 'q8',
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    }).catch((error: unknown) => {
      pipelinePromise = undefined;
      throw error;
    });
    return pipelinePromise;
  };

  return {
    model: MODEL,
    dimensions: DIMENSIONS,
    async embedTexts(texts, opts: EmbeddingOptions = {}) {
      const kind = opts.kind ?? 'passage';
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        opts.signal?.throwIfAborted();
        const batch = texts.slice(start, start + BATCH_SIZE).map((text) => `${kind}: ${text}`);
        const result = await (await getPipeline())(batch, { pooling: 'mean', normalize: true });
        // shortcut: ONNX inference cannot be cancelled mid-call; disable embeddings for FTS fallback, use a worker if hard timeouts become necessary.
        opts.signal?.throwIfAborted();
        const output = result.tolist();
        if (
          !Array.isArray(output) ||
          output.length !== batch.length ||
          !output.every((vector: unknown) => isVector(vector) && vector.length === DIMENSIONS)
        ) {
          throw new Error('embeddings_output_invalid');
        }
        vectors.push(...(output as number[][]));
      }
      return vectors;
    },
  };
}
