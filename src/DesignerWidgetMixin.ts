import { UIInstWidget } from './interfaces';
import { Dimensions, DimensionResults } from '@dojo/framework/widget-core/meta/Dimensions';
import { afterRender } from '@dojo/framework/widget-core/decorators/afterRender';
import { Constructor, DNode, VNode } from '@dojo/framework/widget-core/interfaces';
import { WidgetBase } from '@dojo/framework/widget-core/WidgetBase';
import { beforeProperties } from '@dojo/framework/widget-core/decorators/beforeProperties';
import * as css from './styles/base.m.css';
import Overlay from './Overlay';
import { find } from '@dojo/framework/shim/array';
import { v, w } from '@dojo/framework/widget-core/d';
import { Resize } from '@dojo/framework/widget-core/meta/Resize';
import { EditableWidgetProperties } from './interfaces';

export interface DesignerWidgetMixin {
	properties: EditableWidgetProperties;
}

// 将普通的用户自定义部件转换为可在设计器中使用的部件，提供以下扩展：
// 1. 测量部件尺寸
// 2. 增加遮盖层屏蔽部件中与设计器冲突的事件
// 3. 覆盖部件的获取焦点效果
// 4. 为空容器增加可视化效果
export function DesignerWidgetMixin<T extends new (...args: any[]) => WidgetBase>(
	Base: T
): T & Constructor<DesignerWidgetMixin> {
	abstract class Designable extends Base {
		public abstract properties: EditableWidgetProperties;

		private _key: string = '';

		/**
		 * 问题描述
		 * 部件聚焦时，当通过修改属性值调整聚焦部件的位置且不会触发 Resize Observer 时，
		 * 如调整 Float 的值，则需要一种方法来触发聚焦部件的重绘方法以获取正确的位置信息（用于重绘聚焦框）。
		 *
		 * 注意，Resize Observer 只有在改变了 DOM 节点的 content rect size 时才会触发，而如果将 float 的值从 left 改为 right 时，
		 * DOM 节点的位置发生了变化，而 rect size 并没有发生变化，
		 * 所以没有触发 Resize Observer，参见 https://wicg.github.io/ResizeObserver/#content-rect。
		 *
		 * 解决方法
		 *
		 * 在聚焦部件后添加一个子节点，然后在子部件上传入 deferred properties 来延迟触发 tryFocus 方法，
		 * 即每次绘制完聚焦部件后，都会调用 tryFocus 方法，从而获取到正确的位置信息，实现聚焦框的准确定位。
		 */
		private _triggerResizeWidgetKey: string = '__triggerResize__'; // 如果是系统内使用的字符串，则在字符串的前后分别增加两个 '_'

		protected getDefaultValue() {
			return '';
		}

		private _onMouseUp(event?: MouseEvent) {
			if (event) {
				event.stopImmediatePropagation();
				const { onFocus, widget } = this.properties;
				const dimensions = this.meta(Dimensions).get(this._key);
				onFocus && onFocus({ activeWidgetDimensions: dimensions, activeWidgetId: widget.id });
			}
		}

		protected isContainer(): boolean {
			return false;
		}

		protected needOverlay(): boolean {
			return false;
		}

		@beforeProperties()
		protected beforeProperties(properties: any) {
			if (!properties.widget) {
				return { ...properties };
			}
			// 如果是空容器，则添加可视化效果
			// 当前判断为空容器的条件有:
			// 1. 不包含子节点且 isContainer 返回 true 的部件
			// 2. isContainer 返回 true 子节点中只有游标或者内置的触发 tryFocus 方法的部件
			if (this.isContainer() && (this.children.length === 0 || this._onlyContainsCursor())) {
				return {
					extraClasses: { root: css.emptyContainer },
					...properties.widget.properties, // 设计器中初始化默认的或者通过属性面板修改的属性值
					...properties // 使用 w() 创建部件时传入的属性
				};
			}
			// 存在这么一类部件，不属于容器部件，也不需要遮盖层，支持 value 属性，当 value 值为空且不存在光标之外的子部件的时候需要设置 value 为 '__'
			if (this._valuePropertyIsNull(properties) && (this.children.length === 0 || this._onlyContainsCursor())) {
				// 在设计器中，使用 value 覆盖掉 properties.widget.properties 中的 value 属性值。
				// 但是并不会往 web 版的部件中传修改后的 value 值，还是传 properties.widget.properties 中的 value 值。
				return {
					...properties.widget.properties, // 设计器中初始化默认的或者通过属性面板修改的属性值
					...properties, // 使用 w() 创建部件时传入的属性
					value: this.getDefaultValue()
				};
			}
			return {
				...properties.widget.properties, // 设计器中初始化默认的或者通过属性面板修改的属性值
				...properties // 使用 w() 创建部件时传入的属性
			};
		}

		private _valuePropertyIsNull(properties: any) {
			const { widget } = properties;
			return widget && widget.properties && widget.properties.value === '';
		}

		/**
		 * 一个空容器中最多会包含一个在设计器中使用的特殊部件，
		 * 是用于显示光标(Cursor)的部件，
		 * 这不是用户添加的部件，所以要过滤出来。
		 * 一个空容器中有这个部件时，约定：
		 * 1. 光标作为第一个节点；
		 */
		private _onlyContainsCursor() {
			if (this.children.length > 1) {
				return false;
			}
			const cursorProperties = (this.children[0]! as VNode).properties.widget;
			if (cursorProperties.widgetName === 'Cursor') {
				return true;
			}
			return false;
		}

		// 1. 尝试聚焦
		// 2. 绑定 onmouseup 事件
		// 3. input部件需要增加遮盖层节点
		@afterRender()
		protected afterRender(result: DNode | DNode[]): DNode | DNode[] {
			// 若为虚拟节点数组需要遍历所有节点，找到应用了key的节点，再添加onmouseup事件
			let key: string;
			let widgetNode: VNode;
			if (Array.isArray(result)) {
				result = result as DNode[];
				let node = find(result, (elm, index, array) => {
					return elm !== null && (elm as VNode).properties.key !== undefined;
				});
				widgetNode = node as VNode;
				key = String(widgetNode.properties.key);
			} else {
				widgetNode = result as VNode;
				key = String(widgetNode.properties.key);
				result = [result];
			}
			this._key = key;
			if (this.needOverlay()) {
				// 遮盖层覆盖住了部件节点，需要将 onMouseUp 事件传给遮盖层
				return [
					...result,
					w(Overlay, { dimensions: this.meta(Dimensions).get(key), onMouseUp: this._onMouseUp }),
					this._renderTriggerResizeNode(key)
				];
			} else {
				// 没有遮盖层时需要绑定 onMouseUp 事件到部件节点上
				widgetNode.properties.onmouseup = this._onMouseUp;
			}
			return [...result, this._renderTriggerResizeNode(key)];
		}

		private _renderTriggerResizeNode(key: string): DNode {
			const { widget, activeWidgetId, onFocus } = this.properties;
			if (this._isFocus(widget, activeWidgetId)) {
				// 防止渲染多个 triggerResizeWidget 造成 key 重复报错
				return v('span', (inserted: boolean) => {
					this._tryFocus(widget, activeWidgetId, onFocus, key);
					return { key: this._triggerResizeWidgetKey };
				});
			}
			return null;
		}

		private _isFocus(widget: UIInstWidget, activeWidgetId: string | number) {
			return widget.id === activeWidgetId;
		}

		private _tryFocus(
			widget: UIInstWidget,
			activeWidgetId: string | number,
			onFocus: (
				payload: {
					activeWidgetDimensions: Readonly<DimensionResults>;
					activeWidgetId: string | number;
				}
			) => void,
			key: string
		) {
			if (this._isFocus(widget, activeWidgetId)) {
				this._focus(onFocus, activeWidgetId, key);
			}
		}

		private _focus(
			onFocus: (
				payload: {
					activeWidgetDimensions: Readonly<DimensionResults>;
					activeWidgetId: string | number;
				}
			) => void,
			activeWidgetId: string | number,
			key: string
		) {
			const { widget } = this.properties;
			const dimensions = this.meta(Dimensions).get(key);
			this.meta(Resize).get(String(key), {});
			onFocus && onFocus({ activeWidgetDimensions: dimensions, activeWidgetId: widget.id });
		}
	}
	return Designable;
}
export default DesignerWidgetMixin;
