import { expect, it } from "vitest";
import { arrangeBoard, boardPosition, moveBoardGroups, BOARD_CARD } from "./project-board-layout";
it("moves grouped cards by one common delta and keeps unrelated cards still",()=>{
 const positions={a:{x:0,y:0},b:{x:280,y:20},c:{x:600,y:40}};
 expect(moveBoardGroups(positions,{a:{x:60,y:90}},[{members:['a','b']}])).toEqual({a:{x:60,y:90},b:{x:340,y:110},c:positions.c});
 expect(moveBoardGroups(positions,{a:{x:60,y:90},b:{x:340,y:110}},[{members:['a','b']}]).b).toEqual({x:340,y:110});
 expect(()=>moveBoardGroups(positions,{a:{x:99999,y:0}},[{members:['a','b']}])).toThrow('范围');
});
it("separates rows enough for design thumbnails and long titles",()=>{
 expect(boardPosition(3).y-boardPosition(0).y).toBeGreaterThan(BOARD_CARD.height);
 expect(boardPosition(1).x-boardPosition(0).x).toBeGreaterThan(BOARD_CARD.width);
});
it("aligns only selected references without mutating input",()=>{
 const positions={a:{x:80,y:50},b:{x:20,y:90},c:{x:40,y:150}};
 expect(arrangeBoard(positions,["a","b"],"left")).toEqual({...positions,a:{x:20,y:50}});
 expect(arrangeBoard(positions,["a","b"],"top")).toEqual({...positions,b:{x:20,y:50}});
 expect(positions.a.x).toBe(80);
});
it("distributes crowded cards without overlap and preserves a wider span",()=>{
 const positions={a:{x:0,y:0},b:{x:10,y:10},c:{x:1000,y:1000}};
 expect(arrangeBoard(positions,["a","b"],"horizontal").b!.x).toBe(280);
 expect(arrangeBoard(positions,["a","b","c"],"horizontal").b!.x).toBe(500);
 expect(arrangeBoard(positions,["a","b"],"vertical").b!.y).toBe(340);
 expect(arrangeBoard(positions,["missing","a","a"],"left")).toBe(positions);
});
