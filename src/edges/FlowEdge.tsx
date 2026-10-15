// 连接线：选中或鼠标移上去时，中间出现剪刀，点一下断开；
// 选中的线以及它往下游接着的线，会有顺着方向流动的光。
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';
import { Scissors } from 'lucide-react';

export interface FlowEdgeData {
  hover?: boolean;
  /** 框选了多个节点（线是顺带被选中的） */
  multi?: boolean;
  /** 'selected' 选中的这条；'chain' 顺着往下游的；'node' 选中节点进出的线 */
  flow?: 'selected' | 'chain' | 'node';
  onHover?: (id: string | null) => void;
  [key: string]: unknown;
}

export function FlowEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data } = props;
  const d = (data || {}) as FlowEdgeData;
  const { deleteElements } = useReactFlow();
  // 端点落在圆形接口的正中间（接口直径 14，React Flow 给的是接口外沿）
  const R = 7;
  const sx = sourcePosition === 'right' ? sourceX - R : sourcePosition === 'left' ? sourceX + R : sourceX;
  const tx = targetPosition === 'left' ? targetX + R : targetPosition === 'right' ? targetX - R : targetX;
  const [path, lx, ly] = getBezierPath({ sourceX: sx, sourceY, targetX: tx, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const solo = selected && !d.multi;
  const flow = solo ? 'selected' : d.flow;

  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={22} className={`flow-base ${flow ? `is-${flow}` : ''}`} />
      {flow && <path d={path} className={`edge-flow flow-${flow}`} />}
      {(solo || d.hover) && (
        <EdgeLabelRenderer>
          <div
            className="edge-cut-pos nodrag nopan"
            style={{ position: 'absolute', pointerEvents: 'all', transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
          <button
            className="edge-cut"
            title="断开这条连接"
            onMouseEnter={() => d.onHover?.(id)}
            onMouseLeave={() => d.onHover?.(null)}
            onClick={(e) => {
              e.stopPropagation();
              deleteElements({ edges: [{ id }] });
            }}
          >
            <Scissors size={17} />
          </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
