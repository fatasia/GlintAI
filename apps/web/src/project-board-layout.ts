export type BoardPositions = Record<string, { x: number; y: number }>;
export const BOARD_CARD = { width: 234, height: 300, column: 280, row: 340 };
export function boardPosition(index: number) { return { x: index % 3 * BOARD_CARD.column, y: Math.floor(index / 3) * BOARD_CARD.row }; }
export type BoardArrange = "left" | "top" | "horizontal" | "vertical";
/** A logical group moves as a rigid set, even when only one card received the pointer. */
export function moveBoardGroups(positions:BoardPositions,moved:BoardPositions,groups:Array<{members:string[]}>):BoardPositions {
  const next={...positions,...moved};
  for(const group of groups){
    const anchor=group.members.find(id=>moved[id]&&positions[id]);if(!anchor)continue;
    const dx=moved[anchor]!.x-positions[anchor]!.x,dy=moved[anchor]!.y-positions[anchor]!.y;
    for(const id of group.members)if(positions[id])next[id]={x:positions[id]!.x+dx,y:positions[id]!.y+dy};
  }
  if(Object.values(next).some(point=>![point.x,point.y].every(value=>Number.isFinite(value)&&Math.abs(value)<=100000)))throw new Error("编组移动超出画布范围。");
  return next;
}
/** Only selected references move; source documents and video ordering are untouched. */
export function arrangeBoard(positions: BoardPositions, ids: string[], action: BoardArrange): BoardPositions {
  const selected = [...new Set(ids)].filter(id => positions[id]);
  if (selected.length < 2) return positions;
  const axis = action === "top" || action === "vertical" ? "y" : "x";
  selected.sort((a,b) => positions[a]![axis] - positions[b]![axis]);
  const start = positions[selected[0]!]![axis], end = positions[selected.at(-1)!]![axis];
  const gap = action === "horizontal" ? BOARD_CARD.column : BOARD_CARD.row;
  const step = action === "left" || action === "top" ? 0 : Math.max(gap, (end - start) / (selected.length - 1));
  return { ...positions, ...Object.fromEntries(selected.map((id,index) => [id, { ...positions[id]!, [axis]: start + index * step }])) };
}
