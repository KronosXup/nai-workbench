import { useState } from 'react';
import { X, ImagePlus, Layers, ScanFace, SlidersHorizontal } from 'lucide-react';
import type { ImportedImage, ImportOptions } from './imageImport';
export type ImageUse = 'image'|'vibe'|'character'|'inpaint'|'upscale'|'augment';
export default function ImageImportDialog({image,remaining,model,onUse,onMetadata,onClose}:{image:ImportedImage;remaining:number;model:string;onUse:(kind:ImageUse)=>void;onMetadata:(options:ImportOptions)=>void;onClose:()=>void}) {
  const [options,setOptions]=useState<ImportOptions>({prompt:true,negative:true,characters:true,settings:false,seed:false,append:false,cleanBrackets:false});
  const data=image.metadata,v5=model.startsWith('nai-diffusion-5'),v4=model.startsWith('nai-diffusion-4');
  return <div className="modal-backdrop"><section className="modal image-import-modal" role="dialog" aria-modal="true" aria-label="导入图片">
    <header><div><h2>导入图片</h2><small>{image.name} · {image.width} × {image.height}{remaining>1?` · 还有 ${remaining-1} 张`:''}</small></div><button aria-label="关闭图片导入" onClick={onClose}><X/></button></header>
    <div className="modal-content"><div className="import-source"><img src={`data:image/png;base64,${image.data}`} alt="待导入图片"/><div><p>这张图片用来做什么？</p><div className="import-actions">
      <button onClick={()=>onUse('image')}><ImagePlus size={19}/>图生图</button>
      <button disabled={v5} onClick={()=>onUse('vibe')}><Layers size={19}/>Vibe 风格参考</button>
      <button disabled={!model.startsWith('nai-diffusion-4-5')} onClick={()=>onUse('character')}><ScanFace size={19}/>精准参考</button>
      <button onClick={()=>onUse('inpaint')}>局部重绘</button><button onClick={()=>onUse('upscale')}>放大图片</button><button onClick={()=>onUse('augment')}>导演工具</button>
    </div><p className="muted">{v5?'V5 不支持 Vibe 或精准参考。':v4?'Vibe 在首次生成时自动编码，每张参考预计 2 Anlas；同模型与提取量复用编码。':'Vibe 将直接使用原图。'}</p></div></div>
    {image.warning && <p role="status">{image.warning}</p>}
    {data?<section className="import-metadata"><h3><SlidersHorizontal size={18}/>图片带有生成参数</h3><p>也可以只导入参数，图片不会因此上传。</p>
      <div className="import-options">{([['prompt','正面提示词',data.prompt!==undefined],['negative','负面提示词',data.negative!==undefined],['characters','角色提示词',!!data.characters],['settings','模型与生成设置',!!Object.keys(data.settings).length||!!data.model],['seed','种子',data.seed!==undefined],['append','追加提示词与角色',true],['cleanBrackets','清理导入提示词',data.prompt!==undefined||data.negative!==undefined||!!data.characters]] as const).map(([key,label,enabled])=><label key={key}><input type="checkbox" checked={options[key]&&enabled} disabled={!enabled} onChange={e=>setOptions({...options,[key]:e.target.checked})}/>{label}</label>)}</div>
      <small className="muted">清理导入提示词：去掉方括号、花括号，并整理逗号空格；只处理本次导入的文字。</small>
      {data.prompt && <details><summary>查看提示词</summary><p className="import-prompt">{data.prompt}</p></details>}
      <button className="primary" onClick={()=>onMetadata(options)}>导入选中的参数</button>
    </section>:<p className="muted">未发现可读取的 NAI 生成参数，仍可将图片用作参考或编辑。</p>}
    </div></section></div>;
}
