import { useState } from 'react';
import { joinPrompt, uuid } from './types';
import type { Draft } from './types';

export default function PromptChunks({draft, patch, tagSuggestionsUnavailable}: {draft:Draft; patch:(value:Partial<Draft>)=>void; tagSuggestionsUnavailable:boolean}) {
  const [name,setName]=useState(''), [text,setText]=useState(''), [category,setCategory]=useState('常用');
  const [editingId,setEditingId]=useState<string|null>(null);
  const chunks=draft.chunks ?? [];
  const reset=()=>{setEditingId(null);setName('');setText('');setCategory('常用');};
  const save=()=>{
    const entry={id:editingId ?? uuid(),name:name.trim(),text,category:category.trim()||'常用'};
    patch({chunks:editingId ? chunks.map(chunk=>chunk.id===editingId ? entry : chunk) : [...chunks,entry]});
    reset();
  };
  return <details className="section"><summary>提示词片段</summary><div className="section-body">
    <label><input type="checkbox" checked={draft.tagSuggestionsDisabled === true} disabled={tagSuggestionsUnavailable}
      onChange={event=>patch({tagSuggestionsDisabled:event.target.checked})}/>关闭标签建议</label>
    {tagSuggestionsUnavailable && <small>当前模式没有可用的标签建议接口。</small>}
    <label>名称<input aria-label="片段名称" value={name} onChange={e=>setName(e.target.value)}/></label>
    <label>分类<input aria-label="片段分类" value={category} onChange={e=>setCategory(e.target.value)}/></label>
    <label>内容<textarea aria-label="片段内容" rows={3} value={text} onChange={e=>setText(e.target.value)}/></label>
    <button disabled={!name.trim() || !text.trim()} onClick={save}>{editingId ? '保存修改' : '新建片段'}</button>
    {editingId && <button onClick={reset}>取消编辑</button>}
    {Array.from(new Set(chunks.map(c=>c.category))).map(group=><section key={group}><h3>{group}</h3>
      {chunks.filter(c=>c.category===group).map(c=><div key={c.id} className="prompt-chunk">
        <b>{c.name}</b><p>{c.text}</p>
        <button onClick={()=>patch({prompt:joinPrompt(draft.prompt,c.text)})}>加入正面</button>
        <button onClick={()=>patch({negative:joinPrompt(draft.negative,c.text)})}>加入负面</button>
        <button onClick={()=>{setEditingId(c.id);setName(c.name);setText(c.text);setCategory(c.category);}}>编辑</button>
        <button aria-label={`删除片段 ${c.name}`} onClick={()=>{patch({chunks:chunks.filter(v=>v.id!==c.id)});if(editingId===c.id)reset();}}>删除</button>
      </div>)}
    </section>)}
  </div></details>;
}
