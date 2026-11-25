/// <reference types="vite/client" />

declare module "elkjs/lib/elk-api.js" {
  import type { ELK as ElkInstance, ELKConstructorArguments } from "elkjs";
  const ELKConstructor: new (args?: ELKConstructorArguments) => ElkInstance;
  export default ELKConstructor;
}
