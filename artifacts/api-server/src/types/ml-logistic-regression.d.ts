declare module "ml-logistic-regression" {
  import type { Matrix } from "ml-matrix";

  class LogisticRegressionTwoClasses {
    weights: Matrix | null;
    testScores(features: Matrix): number[];
    toJSON(): unknown;
    static load(model: unknown): LogisticRegressionTwoClasses;
  }

  export interface LROptions {
    numSteps?: number;
    learningRate?: number;
    classifiers?: unknown[];
    numberClasses?: number;
  }

  export default class LogisticRegression {
    numberClasses: number;
    classifiers: LogisticRegressionTwoClasses[];
    constructor(options?: LROptions);
    train(X: Matrix, Y: Matrix): void;
    predict(Xtest: Matrix): number[];
    toJSON(): unknown;
    static load(model: unknown): LogisticRegression;
  }
}
