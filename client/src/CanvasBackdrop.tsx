import { useMemo } from "react";
import "./canvasOutput.css";

type Props = { identity: string };
type Cluster = { side: number; x: number; y: number; radius: number; angle: number; sweep: number };

function ornaments(identity: string) {
  let state = 5381;
  for (let index = 0; index < identity.length; index++) state = (Math.imul(state, 33) ^ identity.charCodeAt(index)) >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const anchors = [
    [0, 10, 18, 58], [0, 55, 85, 105],
    [1, 72, 8, 28], [1, 84, 53, 87], [1, 28, 96, 38],
  ];
  const clusters: Cluster[] = anchors.map(([side, x, y, radius]) => ({
    side, x: x + random() * 16 - 8, y: y + random() * 10 - 5,
    radius: radius * (.9 + random() * .2), angle: random() * 270,
    sweep: 70 + random() * 100,
  }));
  return clusters;
}

export default function CanvasBackdrop({ identity }: Props) {
  const clusters = useMemo(() => ornaments(identity), [identity]);
  return <svg className="nai-canvas-backdrop" width="100%" height="100%" aria-hidden="true" focusable="false">
    {[0, 1].map(side => <svg key={side} x={side === 0 ? "0" : "76%"} width="24%" height="100%" overflow="hidden">
      {clusters.filter(cluster => cluster.side === side).map((cluster, index) => {
        const r = cluster.radius;
        return <svg key={index} className={r > 50 ? "nai-backdrop-cluster is-large" : "nai-backdrop-cluster"}
          x={`${cluster.x}%`} y={`${cluster.y}%`} width="1" height="1" overflow="visible">
          <g transform={`rotate(${cluster.angle})`} fill="none" stroke="currentColor" strokeWidth="1">
            <circle r={r} opacity=".5" />
            <circle r={r + 8} pathLength="360" strokeDasharray={`${cluster.sweep} ${360 - cluster.sweep}`} opacity=".3" />
            <circle cx={r * .93} cy={-r * .67} r={r * .22} opacity=".65" />
            <circle cx={r * .93} cy={-r * .67} r={r * .22 + 4} opacity=".24" />
            <path d={`M ${-r * .72} ${-r * .7} L ${-r * 1.2} ${-r * 1.05} L ${-r * 1.55} ${-r * 1.05}`} opacity=".35" />
            <circle cx={-r * 1.55} cy={-r * 1.05} r="2" fill="currentColor" stroke="none" opacity=".65" />
          </g>
        </svg>;
      })}
      <circle cx={side === 0 ? "48%" : "18%"} cy={side === 0 ? "46%" : "24%"} r="3" fill="none" stroke="currentColor" opacity=".45" />
    </svg>)}
  </svg>;
}
