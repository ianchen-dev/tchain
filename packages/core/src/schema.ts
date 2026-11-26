import { z } from "zod";

export const NODE_ID_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const GRAPH_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const NODE_TIMESTAMP_FIELDS = [
  "createdAt",
  "updatedAt",
  "statusChangedAt"
] as const;

export const NODE_CONTENT_FIELDS = [
  "type",
  "title",
  "status",
  "statusNote",
  "description",
  "conclusion",
  "metrics",
  "attachments",
  "report"
] as const;

export const MUTABLE_NODE_FIELDS = [
  "parentId",
  ...NODE_CONTENT_FIELDS,
  ...NODE_TIMESTAMP_FIELDS
] as const;

export const StatusSchema = z.enum([
  "todo",
  "active",
  "blocked",
  "done",
  "parked",
  "discarded"
]);
export type Status = z.infer<typeof StatusSchema>;

export const NodeTypeSchema = z.enum([
  "goal",
  "decision",
  "option",
  "task",
  "milestone"
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EdgeKindSchema = z.enum(["flow", "depends_on", "revises"]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const MetricToneSchema = z.enum(["neutral", "positive", "warning"]);
export type MetricTone = z.infer<typeof MetricToneSchema>;

export const LayoutDirectionSchema = z.enum(["DOWN", "RIGHT"]);
export type LayoutDirection = z.infer<typeof LayoutDirectionSchema>;

export const MetricSchema = z
  .object({
    label: z.string().min(1),
    value: z.string().min(1),
    tone: MetricToneSchema.optional()
  })
  .strict();
export type Metric = z.infer<typeof MetricSchema>;

export const AttachmentSchema = z
  .object({
    path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    title: z.string().optional(),
    note: z.string().optional()
  })
  .strict();
export type Attachment = z.infer<typeof AttachmentSchema>;

export const NodeSchema = z
  .object({
    id: z.string().regex(NODE_ID_REGEX, "Invalid node id format"),
    parentId: z.string().regex(NODE_ID_REGEX, "Invalid parentId format").optional(),
    type: NodeTypeSchema,
    title: z.string().min(1),
    status: StatusSchema.optional(),
    statusNote: z.string().optional(),
    description: z.string().optional(),
    conclusion: z.string().optional(),
    metrics: z.array(MetricSchema).optional(),
    attachments: z.array(AttachmentSchema).optional(),
    report: z.boolean().optional(),
    createdAt: IsoTimestampSchema.optional(),
    updatedAt: IsoTimestampSchema.optional(),
    statusChangedAt: IsoTimestampSchema.optional()
  })
  .strict();
export type Node = z.infer<typeof NodeSchema>;

export const EdgeSchema = z
  .object({
    source: z.string().regex(NODE_ID_REGEX, "Invalid edge source id"),
    target: z.string().regex(NODE_ID_REGEX, "Invalid edge target id"),
    kind: EdgeKindSchema.optional()
  })
  .strict();
export type Edge = z.infer<typeof EdgeSchema>;

export const LayoutSchema = z
  .object({
    direction: LayoutDirectionSchema.optional()
  })
  .strict();
export type GraphLayout = z.infer<typeof LayoutSchema>;

export const GraphSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1),
    id: z.string().regex(GRAPH_ID_REGEX, "Invalid graph id format"),
    title: z.string().min(1),
    layout: LayoutSchema.optional(),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema)
  })
  .strict();
export type Graph = z.infer<typeof GraphSchema>;

export const MutableNodeFieldSchema = z.enum(MUTABLE_NODE_FIELDS);
export type MutableNodeField = z.infer<typeof MutableNodeFieldSchema>;

export const NodePatchSetSchema = z
  .object({
    parentId: z.string().regex(NODE_ID_REGEX).nullable().optional(),
    type: NodeTypeSchema.optional(),
    title: z.string().min(1).optional(),
    status: StatusSchema.optional(),
    statusNote: z.string().optional(),
    description: z.string().optional(),
    conclusion: z.string().optional(),
    metrics: z.array(MetricSchema).optional(),
    attachments: z.array(AttachmentSchema).optional(),
    report: z.boolean().optional(),
    createdAt: IsoTimestampSchema.optional(),
    updatedAt: IsoTimestampSchema.optional(),
    statusChangedAt: IsoTimestampSchema.optional(),
    after: z.string().regex(NODE_ID_REGEX).nullable().optional()
  })
  .strict();
export type NodePatchSet = z.infer<typeof NodePatchSetSchema>;

export const AddNodeOpSchema = z
  .object({
    op: z.literal("add_node"),
    node: NodeSchema,
    after: z.string().regex(NODE_ID_REGEX).nullable().optional()
  })
  .strict();
export type AddNodeOp = z.infer<typeof AddNodeOpSchema>;

export const UpdateNodeOpSchema = z
  .object({
    op: z.literal("update_node"),
    id: z.string().regex(NODE_ID_REGEX),
    set: NodePatchSetSchema.optional(),
    unset: z.array(MutableNodeFieldSchema).optional()
  })
  .strict();
export type UpdateNodeOp = z.infer<typeof UpdateNodeOpSchema>;

export const RemoveNodeOpSchema = z
  .object({
    op: z.literal("remove_node"),
    id: z.string().regex(NODE_ID_REGEX),
    cascade: z.boolean()
  })
  .strict();
export type RemoveNodeOp = z.infer<typeof RemoveNodeOpSchema>;

export const AddEdgeOpSchema = z
  .object({
    op: z.literal("add_edge"),
    source: z.string().regex(NODE_ID_REGEX),
    target: z.string().regex(NODE_ID_REGEX),
    kind: EdgeKindSchema.optional()
  })
  .strict();
export type AddEdgeOp = z.infer<typeof AddEdgeOpSchema>;

export const RemoveEdgeOpSchema = z
  .object({
    op: z.literal("remove_edge"),
    source: z.string().regex(NODE_ID_REGEX),
    target: z.string().regex(NODE_ID_REGEX)
  })
  .strict();
export type RemoveEdgeOp = z.infer<typeof RemoveEdgeOpSchema>;

export const OpSchema = z.discriminatedUnion("op", [
  AddNodeOpSchema,
  UpdateNodeOpSchema,
  RemoveNodeOpSchema,
  AddEdgeOpSchema,
  RemoveEdgeOpSchema
]);
export type Op = z.infer<typeof OpSchema>;

export const DiagnosticLevelSchema = z.enum(["error", "warning"]);
export type DiagnosticLevel = z.infer<typeof DiagnosticLevelSchema>;

export const DiagnosticSchema = z.object({
  level: DiagnosticLevelSchema,
  opIndex: z.number().int().nonnegative().optional(),
  path: z.string(),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional()
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export function exportGraphJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(GraphSchema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  return {
    $id: "https://tchain.local/schemas/tgraph.schema.json",
    title: "ThoughtChain Graph (v1)",
    ...schema
  };
}
