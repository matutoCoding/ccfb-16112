// 全局领域模型。长度单位统一为毫米(mm)，右手坐标系：
// X = 板宽方向，Y = 板长/高度方向，Z = 板面法向（指向工人/投影仪）。

export type ID = string;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type FixtureKind = 'fork' | 'bracket' | 'tape' | 'connector' | 'cradle';

export interface Cavity {
  id: ID;
  index: number;
  /** 相对接插件中心的坐标，mm */
  dx: number;
  dy: number;
  /** 孔位/端子面相对板面的高度，mm */
  z: number;
  label: string;
}

export interface Fixture {
  id: ID;
  kind: FixtureKind;
  name: string;
  code: string;
  x: number;
  y: number;
  rotation: number;
  /** 叉子/托架高度，或接插件孔位面高度 */
  height: number;
  radius?: number;
  width?: number;
  depth?: number;
  cavityCount?: number;
  pitch?: number;
  rows?: number;
  cavities?: Cavity[];
  color?: string;
  layer?: string;
}

export interface DxfEntity {
  id: ID;
  type: 'line' | 'polyline' | 'circle' | 'arc';
  layer?: string;
  points?: Vec2[];
  center?: Vec2;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
}

export interface DxfDocument {
  fileName: string;
  importedAt: number;
  units: string;
  entities: DxfEntity[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface BoardSpec {
  id: ID;
  name: string;
  material: string;
  width: number;
  height: number;
  thickness: number;
  color: string;
  dxf: DxfDocument | null;
}

export interface WireEndpointRef {
  fixtureId: ID;
  cavityId: ID;
}

export interface Wire {
  id: ID;
  lineNo: string;
  circuit: string;
  crossSection: number;
  color: string;
  colorName: string;
  from: WireEndpointRef;
  to: WireEndpointRef;
  /** 依次经过的叉子/接插件座 ID */
  fixturePath: ID[];
  /** 含堆高的三维走线路径 */
  route: Vec3[];
  lengthMm: number;
  sequence: number;
  branchPointIds: ID[];
  tiePointIds: ID[];
}

export interface TiePoint {
  id: ID;
  kind: 'tie' | 'branch';
  x: number;
  y: number;
  z: number;
  edgeKey?: string;
  wireCount: number;
}

export interface ProjectorDevice {
  id: ID;
  name: string;
  model: string;
  resolutionW: number;
  resolutionH: number;
  /** 投射比 = 光轴投射距离 / 画面宽度 */
  throwRatio: number;
  /** 镜头位移，按画面宽/高的比例计 */
  lensShiftX: number;
  lensShiftY: number;
  lumens: number;
  /** 标称原生对比度，仅用于估算环境光下黑位 */
  nativeContrast: number;
  enabled: boolean;
  pos: Vec3;
  target: Vec3;
  roll: number;
}

export interface GuideStep {
  id: ID;
  order: number;
  wireId: ID;
  title: string;
  workSeconds: number;
}

export interface Settings {
  visibilityThreshold: number;
  accuracyToleranceMm: number;
  /** 投影仪标定残差，默认 0；现场标定后可录入 */
  calibrationResidualMm: number;
  blendWidthPx: number;
  ceilingLightsOn: boolean;
  ambientLux: number;
  workerEnabled: boolean;
  workerFollowStep: boolean;
  workerX: number;
  workerY: number;
  contrastThreshold: number;
  showCoverage: boolean;
  showDensityHeatmap: boolean;
  showContrastHeatmap: boolean;
  camera: 'axon' | 'top' | 'worker';
}

export interface ProjectState {
  schema: 1;
  id: ID;
  name: string;
  board: BoardSpec;
  fixtures: Fixture[];
  wires: Wire[];
  tiePoints: TiePoint[];
  projectors: ProjectorDevice[];
  steps: GuideStep[];
  settings: Settings;
  updatedAt: number;
}

export interface SampleVisibility {
  point: Vec3;
  visible: boolean;
  visibleBy: ID[];
  assignedProjectorId: ID | null;
  reason?: string;
}

export interface StepReport {
  stepId: ID;
  order: number;
  wireId: ID;
  lineNo: string;
  totalSamples: number;
  visibleSamples: number;
  visibility: number;
  assignedProjectorId: ID | null;
  failover: boolean;
  blockedByArms: number;
  blockedByHarness: number;
  outsideCoverage: number;
  minContrast: number;
  minDensityPpi: number;
  maxAccuracyErrorMm: number;
  passed: boolean;
  issues: string[];
}

export interface Recommendation {
  severity: 'add' | 'move' | 'calibrate';
  title: string;
  detail: string;
  projectorId?: ID;
  suggestedPos?: Vec3;
  expectedGain: number;
}

export interface AccuracyReport {
  maxHoleErrorMm: number;
  maxStackErrorMm: number;
  sampleCount: number;
  occludedStackSamples: number;
  toleranceMm: number;
  passed: boolean;
  worst: { label: string; errorMm: number; x: number; y: number; z: number } | null;
}
