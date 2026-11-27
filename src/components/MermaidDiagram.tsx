import { useEffect, useId, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'strict',
  htmlLabels: false,
  suppressErrorRendering: true,
  themeVariables: {
    darkMode: false,
    background: '#E5F1F7',
    primaryColor: '#D8EAF3',
    primaryTextColor: '#172D3A',
    primaryBorderColor: '#AFCFDF',
    lineColor: '#559DBE',
    secondaryColor: '#EAF4F8',
    tertiaryColor: '#CFE5F0',
    fontFamily: 'Onest, sans-serif',
    fontSize: '12px',
  },
});

export function MermaidDiagram({ code }: { code: string }) {
  const reactId = useId().replace(/:/g, '_');
  const [svg, setSvg] = useState<string>('');
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!code.trim()) return;
      try {
        setRenderError(null);
        const { svg: rendered } = await mermaid.render(`mmd_${reactId}`, code);
        if (rendered.includes('aria-roledescription="error"') || rendered.includes('Syntax error in text')) {
          throw new Error('Diagram syntax could not be rendered cleanly.');
        }
        if (!cancelled) {
          setSvg(rendered);
        }
      } catch (err) {
        if (!cancelled) {
          setSvg('');
          setRenderError(err instanceof Error ? err.message : 'Unable to render Mermaid syntax.');
        }
      }
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [code, reactId]);

  if (renderError) {
    return (
      <div className="rounded-lg border border-[#232832] bg-[#111419] p-4 text-xs text-[#9CA3AF]">
        <p className="mb-2 text-amber-400">Mermaid preview fallback:</p>
        <pre className="overflow-x-auto font-mono text-[11px] text-[#D1D5DB]">{code}</pre>
      </div>
    );
  }

  return (
    <div
      className="w-full overflow-auto rounded-lg border border-[#232832] bg-[#0F1217] p-4 [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
