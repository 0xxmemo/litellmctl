import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Splitter, CodeChunk } from './index';

type SupportedLanguage = "cpp" | "go" | "java" | "js" | "php" | "proto" | "python" | "rst" | "ruby" | "rust" | "scala" | "swift" | "markdown" | "latex" | "html" | "sol";

export class LangChainCodeSplitter implements Splitter {
    private chunkSize: number = 1000;
    private chunkOverlap: number = 200;

    constructor(chunkSize?: number, chunkOverlap?: number) {
        if (chunkSize) this.chunkSize = chunkSize;
        if (chunkOverlap) this.chunkOverlap = chunkOverlap;
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        try {
            const mappedLanguage = this.mapLanguage(language);
            if (mappedLanguage) {
                const splitter = RecursiveCharacterTextSplitter.fromLanguage(
                    mappedLanguage,
                    { chunkSize: this.chunkSize, chunkOverlap: this.chunkOverlap },
                );
                const documents = await splitter.createDocuments([code]);
                return documents.map((doc) => {
                    const lines = (doc.metadata as any)?.loc?.lines || { from: 1, to: 1 };
                    return {
                        content: doc.pageContent,
                        metadata: { startLine: lines.from, endLine: lines.to, language, filePath },
                    };
                });
            }
            return this.fallbackSplit(code, language, filePath);
        } catch (error) {
            console.error('[LangChainSplitter] Error splitting code:', error);
            return this.fallbackSplit(code, language, filePath);
        }
    }

    setChunkSize(chunkSize: number): void { this.chunkSize = chunkSize; }
    setChunkOverlap(chunkOverlap: number): void { this.chunkOverlap = chunkOverlap; }

    private mapLanguage(language: string): SupportedLanguage | null {
        const languageMap: Record<string, SupportedLanguage> = {
            javascript: 'js', typescript: 'js', python: 'python', java: 'java',
            cpp: 'cpp', 'c++': 'cpp', c: 'cpp', go: 'go', rust: 'rust',
            php: 'php', ruby: 'ruby', swift: 'swift', scala: 'scala',
            html: 'html', markdown: 'markdown', md: 'markdown', latex: 'latex',
            tex: 'latex', solidity: 'sol', sol: 'sol',
        };
        return languageMap[language.toLowerCase()] || null;
    }

    private async fallbackSplit(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.chunkSize,
            chunkOverlap: this.chunkOverlap,
        });
        const documents = await splitter.createDocuments([code]);
        return documents.map((doc) => {
            const lines = this.estimateLines(doc.pageContent, code);
            return {
                content: doc.pageContent,
                metadata: { startLine: lines.start, endLine: lines.end, language, filePath },
            };
        });
    }

    private estimateLines(chunk: string, originalCode: string): { start: number; end: number } {
        const chunkLines = chunk.split('\n');
        const chunkStart = originalCode.indexOf(chunk);
        if (chunkStart === -1) return { start: 1, end: chunkLines.length };
        const beforeChunk = originalCode.substring(0, chunkStart);
        const startLine = beforeChunk.split('\n').length;
        const endLine = startLine + chunkLines.length - 1;
        return { start: startLine, end: endLine };
    }
}
