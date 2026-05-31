import { validateShape, type SubagentShape } from "../contracts/subagent-shape.js";

export class PackRegistry {
  private readonly shapes = new Map<string, SubagentShape>();

  constructor(shapes: SubagentShape[]) {
    for (const s of shapes) {
      validateShape(s);
      if (this.shapes.has(s.id)) throw new Error(`PackRegistry: duplicate shape id ${s.id}`);
      this.shapes.set(s.id, s);
    }
  }

  get(id: string): SubagentShape | undefined {
    return this.shapes.get(id);
  }

  has(id: string): boolean {
    return this.shapes.has(id);
  }
}
