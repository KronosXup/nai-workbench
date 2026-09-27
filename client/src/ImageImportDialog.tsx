import { useState, type ReactNode } from 'react';
import { ChevronDown, ImagePlus, Layers, ScanFace, SlidersHorizontal, WandSparkles, X } from 'lucide-react';
import type { ImportedImage, ImportOptions } from './imageImport';

export type ImageUse = 'image'|'vibe'|'character'|'inpaint'|'upscale'|'augment';
type Props = {
  image: ImportedImage;
  remaining: number;
  model: string;
  unavailable?: Partial<Record<ImageUse, string>>;
  onUse: (kind: ImageUse) => void;
  onMetadata: (options: ImportOptions) => void;
  onClose: () => void;
};

export default function ImageImportDialog({image,remaining,model,unavailable={},onUse,onMetadata,onClose}:Props) {
  const [options,setOptions]=useState<ImportOptions>({prompt:true,negative:true,characters:true,settings:false,seed:false,append:false,cleanBrackets:false});
  const [moreUses,setMoreUses]=useState(false);
  const data=image.metadata;
  const v4=model.startsWith('nai-diffusion-4');
  const useButton=(kind:ImageUse,label:string,icon:ReactNode,pixelLimited=false)=>{
    const reason=unavailable[kind] ?? (pixelLimited && image.width*image.height>3145728 ? '图片超过工具的 3145728 像素上限，请先缩小' : undefined);
    return <button type="button" className={reason?'is-unavailable':''} disabled={Boolean(reason)} title={reason} aria-label={reason?`${label}：${reason}`:label} onClick={()=>onUse(kind)} key={kind}>
      {icon}<span>{label}</span>{reason&&<small>{reason}</small>}
    </button>;
  };

  return <div className="modal-backdrop">
    <section className="modal image-import-modal" role="dialog" aria-modal="true" aria-labelledby="image-import-title">
      <header className="image-import-heading">
        <div><h2 id="image-import-title">这张图片要用来做什么？</h2>
          <small>{image.name}{remaining>1?` · 还有 ${remaining-1} 张`:''}</small>
        </div>
        <button type="button" aria-label="关闭图片导入" onClick={onClose}><X/></button>
      </header>
      <div className="modal-content">
        <div className="import-preview"><img src={`data:image/png;base64,${image.data}`} alt="待导入图片"/><span>{image.width} × {image.height}</span></div>
        <div className="import-use-picker">
          <div className="import-actions import-primary-actions">
            {useButton('image','图生图',<ImagePlus size={19}/>)}
            {useButton('vibe','Vibe Transfer',<Layers size={19}/>)}
            {useButton('character','精准参考',<ScanFace size={19}/>)}
          </div>
          {v4 && !model.startsWith('nai-diffusion-5') && <p className="import-vibe-note">Vibe 参考会在首次生成时自动编码；同模型和提取量可复用编码。</p>}
          <details className="import-more-uses" open={moreUses} onToggle={event=>setMoreUses(event.currentTarget.open)}>
            <summary aria-label="更多用途"><span>更多用途</span><ChevronDown size={15}/></summary>
            <div className="import-actions import-secondary-actions">
              {useButton('inpaint','局部重绘',<WandSparkles size={17}/>)}
              {useButton('upscale','放大图片',<WandSparkles size={17}/>, true)}
              {useButton('augment','导演工具',<WandSparkles size={17}/>, true)}
            </div>
          </details>
        </div>
        {image.warning && <p role="status">{image.warning}</p>}
        {data ? <section className="import-metadata"><h3><SlidersHorizontal size={18}/>图片带有生成参数</h3><p>也可以只导入参数，图片不会因此上传。</p>
          <div className="import-options">{([['prompt','正面提示词',data.prompt!==undefined],['negative','负面提示词',data.negative!==undefined],['characters','角色提示词',!!data.characters],['settings','模型与生成设置',!!Object.keys(data.settings).length||!!data.model],['seed','种子',data.seed!==undefined],['append','追加提示词与角色',true],['cleanBrackets','清理导入提示词',data.prompt!==undefined||data.negative!==undefined||!!data.characters]] as const).map(([key,label,enabled])=><label key={key}><input type="checkbox" checked={options[key]&&enabled} disabled={!enabled} onChange={e=>setOptions({...options,[key]:e.target.checked})}/>{label}</label>)}</div>
          <small className="muted">清理导入提示词：去掉方括号、花括号，并整理逗号空格；只处理本次导入的文字。</small>
          {data.prompt && <details><summary>查看提示词</summary><p className="import-prompt">{data.prompt}</p></details>}
          <button type="button" className="primary" onClick={()=>onMetadata(options)}>导入选中的参数</button>
        </section> : <p className="import-no-metadata">未发现可读取的 NAI 生成参数。</p>}
      </div>
    </section>
  </div>;
}
