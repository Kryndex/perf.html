// @flow
import React, { PureComponent } from 'react';
import FlameChartCanvas from './FlameChartCanvas';
import type { Thread, IndexIntoStackTable } from '../../common/types/profile';
import type {
  Milliseconds,
  CssPixels,
  UnitIntervalOfProfileRange,
  StartEndRange,
} from '../../common/types/units';
import type { StackTimingByDepth } from '../stack-timing';
import type { GetCategory } from '../color-categories';
import type { UpdateProfileSelection } from '../actions/profile-view';
import type { ProfileSelection } from '../actions/types';

type Props = {
  thread: Thread,
  maxStackDepth: number,
  stackTimingByDepth: StackTimingByDepth,
  isSelected: boolean,
  timeRange: StartEndRange,
  threadIndex: number,
  interval: Milliseconds,
  maxViewportHeight: number,
  stackFrameHeight: number,
  getCategory: GetCategory,
  getLabel: (Thread, IndexIntoStackTable) => string,
  isThreadExpanded: boolean,
  maximumZoom: UnitIntervalOfProfileRange,
  updateProfileSelection: UpdateProfileSelection,
  selection: ProfileSelection,
};

require('./FlameChartViewport.css');

const LINE_SCROLL_MODE = 1;
const SCROLL_LINE_SIZE = 15;

/**
 * Viewport terminology:
 *                                                  (this time is relative to current
 *                                                   profile range, not the total profile)
 *                 <------ e.g. 1000px ------>         0.7 - Sample's unit time
 *                 ___________________________          |
 *         _______|___________________________|_________|______________________
 *        |       |                           |         v                      |
 * |<-------------|---------------------------|---------*------- Total profile samples ------>|
 *        |       |                           |                                |
 *        |       |      Screen Viewport      |                                |
 *        |       |                           |         Current profile range  |
 *        |_______|___________________________|________________________________|
 *                |___________________________|
 *        ^       ^                           ^                                ^
 *        0.0    0.1                          0.6                              1.0
 *                 ^ viewportLeft               ^ viewportRight
 *
 * viewportLeft = 0.1 <- shared across timelines
 * viewportRight = 0.6 <- shared across timelines
 * viewportLength = viewportRight - viewportLeft
 * viewportTop = 30 (in pixels)
 * screenWidth = 1000
 * unitPixel = viewportLength / screenWidth
 * viewportRight += mouseMoveDelta * unitPixel
 * viewportLeft += mouseMoveDelta * unitPixel
 **/
class FlameChartViewport extends PureComponent {

  props: Props

  state: {
    containerWidth: CssPixels,
    containerHeight: CssPixels,
    containerLeft: CssPixels,
    viewportTop: CssPixels,
    viewportBottom: CssPixels,
    viewportLeft: UnitIntervalOfProfileRange,
    viewportRight: UnitIntervalOfProfileRange,
    dragX: CssPixels,
    dragY: CssPixels,
    isDragging: boolean,
  }

  constructor(props: Props) {
    super(props);

    (this: any)._mouseWheelListener = this._mouseWheelListener.bind(this);
    (this: any)._mouseDownListener = this._mouseDownListener.bind(this);
    (this: any)._mouseMoveListener = this._mouseMoveListener.bind(this);
    (this: any)._mouseUpListener = this._mouseUpListener.bind(this);

    (this: any)._setSize = this._setSize.bind(this);

    /**
     * TODO - Evaluate whether this state should stay in the component, or go out to
     * the redux stores. This state information potentially gets changed very frequently
     * with mouse events.
     */
    this.state = this.getDefaultState(props);
  }

  getHorizontalViewport({ selection, timeRange }: Props) {
    if (selection.hasSelection) {
      const { selectionStart, selectionEnd } = selection;
      const timeRangeLength = timeRange.end - timeRange.start;
      return {
        viewportLeft: (selectionStart - timeRange.start) / timeRangeLength,
        viewportRight: (selectionEnd - timeRange.start) / timeRangeLength,
      };
    }
    return {
      viewportLeft: 0,
      viewportRight: 1,
    };
  }

  getDefaultState(props: Props) {
    const { viewportLeft, viewportRight } = this.getHorizontalViewport(props);
    return {
      containerWidth: 0,
      containerHeight: 0,
      containerLeft: 0,
      viewportTop: 0,
      viewportBottom: 0,
      viewportLeft,
      viewportRight,
      dragX: 0,
      dragY: 0,
      isDragging: false,
    };
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.stackTimingByDepth !== this.props.stackTimingByDepth) {
      this.setState({ viewportTop: 0 });
      this._setSize();
    }
  }

  componentWillReceiveProps(newProps: Props) {
    if (
      this.props.selection !== newProps.selection ||
      this.props.timeRange !== newProps.timeRange
    ) {
      this.setState(this.getHorizontalViewport(newProps));
    }
  }

  _setSize() {
    // Defer setting the size until the next animation frame to ensure proper layout of
    // the container element.
    requestAnimationFrame(() => {
      const rect = this.refs.container.getBoundingClientRect();
      if (this.state.containerWidth !== rect.width || this.state.containerHeight !== rect.height) {
        const style = window.getComputedStyle(this.refs.container);

        // Obey margins of the containing element.
        const containerWidth = rect.width - parseFloat(style.marginLeft) - parseFloat(style.marginRight);
        const containerHeight = rect.height - parseFloat(style.marginTop) - parseFloat(style.marginBottom);
        const containerLeft = rect.left + parseFloat(style.marginLeft);
        const viewportBottom = this.state.viewportTop + containerHeight;

        this.setState({ containerWidth, containerHeight, containerLeft, viewportBottom });
      }
    });
  }

  _mouseWheelListener(event: SyntheticWheelEvent) {
    if (!this.props.isThreadExpanded) {
      // Maybe this should only be listening when expanded.
      return;
    }
    event.preventDefault();
    const { maximumZoom } = this.props;
    const { containerLeft, containerWidth, viewportLeft, viewportRight } = this.state;
    const mouseCenter = (event.clientX - containerLeft) / containerWidth;
    const deltaY = event.deltaMode === LINE_SCROLL_MODE
      ? event.deltaY * SCROLL_LINE_SIZE
      : event.deltaY;

    const viewportLength: CssPixels = viewportRight - viewportLeft;
    const scale = viewportLength - viewportLength / (1 + deltaY * 0.001);
    let newViewportLeft: UnitIntervalOfProfileRange = clamp(0, 1, viewportLeft - scale * mouseCenter);
    let newViewportRight: UnitIntervalOfProfileRange = clamp(0, 1, viewportRight + scale * (1 - mouseCenter));

    if (newViewportRight - newViewportLeft < maximumZoom) {
      const newViewportMiddle = (viewportLeft + viewportRight) * 0.5;
      newViewportLeft = newViewportMiddle - maximumZoom * 0.5;
      newViewportRight = newViewportMiddle + maximumZoom * 0.5;
    }

    const { updateProfileSelection, timeRange } = this.props;
    if (newViewportLeft === 0 && newViewportRight === 1) {
      if (viewportLeft === 0 && viewportRight === 1) {
        // Do not update if at the maximum bounds.
        return;
      }
      updateProfileSelection({
        hasSelection: false,
        isModifying: false,
      });
    } else {
      const timeRangeLength = timeRange.end - timeRange.start;
      updateProfileSelection({
        hasSelection: true,
        isModifying: false,
        selectionStart: timeRange.start + timeRangeLength * newViewportLeft,
        selectionEnd: timeRange.start + timeRangeLength * newViewportRight,
      });
    }
  }

  _mouseDownListener(event: SyntheticMouseEvent) {
    this.setState({
      dragX: event.clientX,
      dragY: event.clientY,
      isDragging: true,
    });
    event.stopPropagation();
    event.preventDefault();

    window.addEventListener('mousemove', this._mouseMoveListener, true);
    window.addEventListener('mouseup', this._mouseUpListener, true);
  }

  _mouseMoveListener(event: SyntheticMouseEvent) {
    event.stopPropagation();
    event.preventDefault();
    const { maxViewportHeight, timeRange, updateProfileSelection } = this.props;
    const { dragX, dragY, containerWidth, containerHeight, viewportTop, viewportLeft, viewportRight } = this.state;

    // Calculate left and right in terms of the unit interval of the profile range.
    const viewportLength: CssPixels = viewportRight - viewportLeft;
    const unitOffsetX: UnitIntervalOfProfileRange = viewportLength * (event.clientX - dragX) / containerWidth;
    let newViewportLeft: CssPixels = viewportLeft - unitOffsetX;
    let newViewportRight: CssPixels = viewportRight - unitOffsetX;
    if (newViewportLeft < 0) {
      newViewportLeft = 0;
      newViewportRight = viewportLength;
    }
    if (newViewportRight > 1) {
      newViewportLeft = 1 - viewportLength;
      newViewportRight = 1;
    }

    // Calculate top and bottom in terms of pixels.
    let newViewportTop: CssPixels = viewportTop - (event.clientY - dragY);
    let newViewportBottom: CssPixels = newViewportTop + containerHeight;

    // Constrain the viewport to the bottom.
    if (newViewportBottom > maxViewportHeight) {
      newViewportTop = maxViewportHeight - containerHeight;
      newViewportBottom = maxViewportHeight;
    }

    // Constrain the viewport to the top. This must be after constraining to the bottom
    // so if the view is extra small the content is anchored to the top, and not the bottom.
    if (newViewportTop < 0) {
      newViewportTop = 0;
      newViewportBottom = containerHeight;
    }

    const timeRangeLength = timeRange.end - timeRange.start;
    updateProfileSelection({
      hasSelection: true,
      isModifying: false,
      selectionStart: timeRange.start + timeRangeLength * newViewportLeft,
      selectionEnd: timeRange.start + timeRangeLength * newViewportRight,
    });

    this.setState({
      dragX: event.clientX,
      dragY: event.clientY,
      viewportTop: newViewportTop,
      viewportBottom: newViewportBottom,
    });
  }

  _mouseUpListener(event: SyntheticMouseEvent) {
    event.stopPropagation();
    event.preventDefault();
    window.removeEventListener('mousemove', this._mouseMoveListener, true);
    window.removeEventListener('mouseup', this._mouseUpListener, true);
    this.setState({
      isDragging: false,
    });
  }

  componentDidMount() {
    window.addEventListener('resize', this._setSize, false);
    this._setSize();
  }

  componentWillUnmount() {
    window.removeEventListener('resize', this._setSize, false);
    window.removeEventListener('mousemove', this._mouseMoveListener, true);
    window.removeEventListener('mouseup', this._mouseUpListener, true);
  }

  render() {
    const {
      thread, interval, timeRange, maxStackDepth, stackTimingByDepth, getCategory,
      getLabel, stackFrameHeight, isThreadExpanded,
    } = this.props;

    const {
      containerWidth, containerHeight, viewportTop, viewportBottom, viewportLeft,
      viewportRight, isDragging,
    } = this.state;

    const viewportClassName = 'flameChartViewport' +
      (isThreadExpanded ? ' expanded' : ' collapsed') +
      (isDragging ? ' dragging' : '');

    return (
      <div className={viewportClassName}
           onWheel={this._mouseWheelListener}
           onMouseDown={this._mouseDownListener}
           ref='container'>
        <FlameChartCanvas interval={interval}
                          thread={thread}
                          rangeStart={timeRange.start}
                          rangeEnd={timeRange.end}
                          stackTimingByDepth={stackTimingByDepth}
                          containerWidth={containerWidth}
                          containerHeight={containerHeight}
                          getCategory={getCategory}
                          getLabel={getLabel}
                          viewportLeft={viewportLeft}
                          viewportRight={viewportRight}
                          viewportTop={viewportTop}
                          viewportBottom={viewportBottom}
                          maxStackDepth={maxStackDepth}
                          stackFrameHeight={stackFrameHeight} />
      </div>
    );
  }
}

export default FlameChartViewport;

function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value));
}
