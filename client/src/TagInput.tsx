import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

export type TagSuggestion = { tag: string; count: number };
type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  model: string;
  suggest?: (model: string, fragment: string) => Promise<TagSuggestion[]>;
  disabled?: boolean;
  placeholder?: string;
};

let lastLookupAt = 0;
const delimiters = /[,|\n{}\[\]#]/;
export function tagFragment(value: string, cursor: number) {
  let start = Math.min(cursor, value.length);
  while (start > 0 && !delimiters.test(value[start - 1])) start--;
  // Numeric emphasis uses 1.2::tag::; suggest against the tag, not the weight.
  const emphasis=value.lastIndexOf('::',cursor-1);
  if(emphasis>=0)start=Math.max(start,emphasis+2);
  let end = Math.min(cursor, value.length);
  while (end < value.length && !delimiters.test(value[end]) && value.slice(end,end+2)!=='::') end++;
  const raw = value.slice(start, cursor);
  const leading = raw.match(/^\s*/)?.[0].length ?? 0;
  return { start: start + leading, end, query: raw.slice(leading).trim() };
}

export default function TagInput({label,value,onChange,model,suggest,disabled,placeholder}: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [cursor,setCursor] = useState(value.length);
  const [focused,setFocused] = useState(false);
  const [tags,setTags] = useState<TagSuggestion[]>([]);
  const [selected,setSelected] = useState(0);
  const [message,setMessage] = useState('');
  const request = useRef(0);
  const fragment = tagFragment(value,cursor);

  useEffect(() => {
    const serial=++request.current;
    if (!focused || disabled || !suggest || fragment.query.length < 2 || fragment.query.length > 20) {
      setTags([]);setMessage('');return;
    }
    // The deployed Gate admits at most one tag lookup per Key every 15 seconds.
    // Keep a shared gap across positive/negative editors instead of provoking 429s.
    const delay=Math.max(900,15500-(Date.now()-lastLookupAt));
    const timer=window.setTimeout(() => {
      lastLookupAt=Date.now();
      void suggest(model,fragment.query).then(rows => {
        if(request.current!==serial)return;
        setTags(rows.slice(0,8));setSelected(0);setMessage('');
      },() => {
        if(request.current!==serial)return;
        setTags([]);setMessage('标签查询暂不可用');
      });
    },delay);
    return () => {window.clearTimeout(timer);request.current++;};
  },[value,cursor,focused,disabled,model,suggest,fragment.query]);

  function choose(tag: string) {
    const {start,end}=tagFragment(value,input.current?.selectionStart ?? cursor);
    const suffix=value.slice(end);
    const insert=tag+(suffix ? '' : ', ');
    const next=value.slice(0,start)+insert+suffix;
    onChange(next);setTags([]);setMessage('');setFocused(false);
    requestAnimationFrame(()=>{
      input.current?.focus();
      const at=start+insert.length;
      input.current?.setSelectionRange(at,at);
      setCursor(at);
    });
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter confirms the IME candidate before it can select a tag suggestion.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!tags.length)return;
    if(event.key==='ArrowDown' || event.key==='ArrowUp') {
      event.preventDefault();setSelected(index=>(index+(event.key==='ArrowDown'?1:tags.length-1))%tags.length);
    } else if(event.key==='Enter') {
      event.preventDefault();choose(tags[selected].tag);
    } else if(event.key==='Escape') {
      event.preventDefault();setTags([]);setFocused(false);
    }
  }
  return <div className="nai-tag-input">
    <textarea ref={input} className="nai-prompt-input" aria-label={label} aria-autocomplete={suggest && !disabled ? 'list' : 'none'}
      aria-expanded={tags.length>0} placeholder={placeholder} value={value}
      onChange={event=>{onChange(event.target.value);setCursor(event.target.selectionStart);setFocused(true);}}
      onSelect={event=>setCursor(event.currentTarget.selectionStart)}
      onFocus={()=>setFocused(true)} onBlur={()=>{setFocused(false);setTags([]);}}
      onKeyDown={keyDown}/>
    {focused && tags.length>0 && <div className="nai-tag-suggestions" role="listbox" aria-label={`${label}标签建议`}>
      {tags.map((item,index)=><button key={`${item.tag}-${index}`} type="button" role="option" aria-selected={selected===index}
        onMouseDown={event=>event.preventDefault()} onClick={()=>choose(item.tag)}>
        <span>{item.tag}</span><small>{item.count ? item.count.toLocaleString() : ''}</small>
      </button>)}
    </div>}
    {focused && message && <small className="nai-tag-error" role="status">{message}</small>}
  </div>;
}
