import React from 'react';
/** Small inert text renderer; HTML and links never become executable markup. */
export function MessageBody({ text }: { text: string }) {
  const inline = (value: string) =>
    value
      .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
      .map((part, i) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={i}>{part.slice(1, -1)}</code>
        ) : part.startsWith('**') && part.endsWith('**') ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          part
        ),
      );
  return (
    <div className="message-body">
      {text.split(/(```[\s\S]*?```)/g).map((part, i) =>
        part.startsWith('```') ? (
          <pre className="message-code" key={i}>
            <code>{part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code>
          </pre>
        ) : (
          <div key={i}>
            {part.split('\n').map((line, j) =>
              /^#{1,4} /.test(line) ? (
                <h3 key={j}>{inline(line.replace(/^#+ /, ''))}</h3>
              ) : /^\s*[-*] /.test(line) ? (
                <p className="message-bullet" key={j}>
                  • {inline(line.replace(/^\s*[-*] /, ''))}
                </p>
              ) : (
                <p key={j}>{inline(line) || <br />}</p>
              ),
            )}
          </div>
        ),
      )}
    </div>
  );
}
