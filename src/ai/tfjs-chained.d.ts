// 类型层：注册 tfjs-core 的链式操作（.mul / .add / .reshape 等）。
// 完整版 @tensorflow/tfjs 会自动注册这些操作；我们只依赖 @tensorflow/tfjs-core，
// 因此在这里显式引入同一注册模块（运行时注册在 engineWorker.ts 中同步引入）。
import '@tensorflow/tfjs-core/dist/public/chained_ops/register_all_chained_ops';
