import { useEffect, useState } from 'react';
import { DraftBank } from './ui-model.ts';
const drafts = new DraftBank();
export function clearDrafts() {
  drafts.reset();
}
export function useDraft(scope: string): [string, (text: string) => void] {
  const [text, setText] = useState(() => drafts.get(scope));
  useEffect(() => {
    setText(drafts.get(scope));
    return drafts.subscribe(() => setText(''));
  }, [scope]);
  return [
    text,
    (next) => {
      drafts.set(scope, next);
      setText(next);
    },
  ];
}
