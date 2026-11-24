import { createSeedProject } from '../src/lib/seed';
import { computeAccuracy, computeAllReports } from '../src/lib/guide';

const state = createSeedProject();
console.log(`种子数据：${state.fixtures.length} 个工装，${state.wires.length} 根导线，${state.projectors.length} 台投影仪，${state.steps.length} 步`);

const accuracy = computeAccuracy(state);
console.log('精度报告：', {
  samples: accuracy.sampleCount,
  occludedStackSamples: accuracy.occludedStackSamples,
  holeMaxMm: Number(accuracy.maxHoleErrorMm.toFixed(4)),
  stackMaxMm: Number(accuracy.maxStackErrorMm.toFixed(4)),
  toleranceMm: accuracy.toleranceMm,
  passed: accuracy.passed,
  worst: accuracy.worst
});

if (!accuracy.passed) {
  console.error('存在超过 3mm 公差的孔位/堆高点');
  process.exit(1);
}

const reports = await computeAllReports(state);
const avg = reports.reduce((sum, r) => sum + r.visibility, 0) / reports.length;
const failed = reports.filter((r) => !r.passed);
const failover = reports.filter((r) => r.failover).length;
console.log('可见率报告：', {
  steps: reports.length,
  average: `${(avg * 100).toFixed(2)}%`,
  belowThreshold: failed.length,
  failoverSteps: failover,
  worstFive: [...reports].sort((a, b) => a.visibility - b.visibility).slice(0, 5).map((r) => ({
    step: r.order,
    line: r.lineNo,
    visibility: `${(r.visibility * 100).toFixed(1)}%`,
    arms: r.blockedByArms,
    harness: r.blockedByHarness,
    outside: r.outsideCoverage
  }))
});

if (reports.length !== 200) {
  console.error('步骤数不是 200');
  process.exit(1);
}
console.log('验证通过：所有孔位指引框几何偏差均不超过 3mm。');
