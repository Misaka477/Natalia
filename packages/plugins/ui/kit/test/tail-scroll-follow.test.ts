import { expect, test } from "bun:test";
import { TailScrollController } from "../src/scroll-controller";

/**
 * Tail-follow: the reader's scroll wins over the runtime's scroll (S6).
 *
 * The reported defect: while the model streams, scrolling UP snaps back to
 * the bottom. The mechanism is here — a programmatic follow-scroll sets a
 * flag so its own scroll event is not mistaken for the reader's, and the
 * reader's wheel-up can land while that flag is still armed. Eating that
 * event re-armed follow, and the next frame yanked the viewport down.
 */

/** A scrollport the controller can read, with a settable position. */
function pane(geometry: { scrollHeight: number; clientHeight: number }) {
  let scrollTop = geometry.scrollHeight - geometry.clientHeight;
  return {
    scrollHeight: geometry.scrollHeight,
    clientHeight: geometry.clientHeight,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
  } as unknown as HTMLElement;
}

function controllerFor(element: HTMLElement) {
  const ended: Array<number> = [];
  const controller = new TailScrollController({
    getScrollElement: () => element,
    scrollToEnd: () => {
      ended.push(element.scrollTop);
      element.scrollTop = element.scrollHeight;
    },
  });
  return { controller, ended };
}

test("a programmatic follow-scroll is not mistaken for the reader", () => {
  const element = pane({ scrollHeight: 10_000, clientHeight: 500 });
  const { controller } = controllerFor(element);
  expect(controller.isFollowing()).toBe(true);
  // The follow scroll itself: its event lands at the end, so follow stays on.
  controller.notifyDataChanged();
  controller.onScroll({ currentTarget: element } as unknown as Event);
  expect(controller.isFollowing()).toBe(true);
});

test("the reader's wheel-up during streaming breaks follow, and it stays broken", () => {
  // The reported sequence: the model is streaming (a follow-scroll has just
  // armed the flag) and the reader scrolls up. That event is the READER's.
  const element = pane({ scrollHeight: 10_000, clientHeight: 500 });
  const { controller } = controllerFor(element);
  // A streaming frame's follow scroll arms the flag but its scroll event has
  // not been delivered yet.
  controller.notifyDataChanged();
  // The reader's wheel-up arrives first: 300px above the bottom.
  element.scrollTop = element.scrollHeight - element.clientHeight - 300;
  controller.onScroll({ currentTarget: element } as unknown as Event);
  expect(controller.isFollowing()).toBe(false);
  // And the next streaming frame must NOT pull the viewport back down.
  element.scrollTop = element.scrollHeight - element.clientHeight - 300;
  controller.notifyDataChanged();
  expect(element.scrollTop).toBe(
    element.scrollHeight - element.clientHeight - 300,
  );
});

test("scrolling back to the bottom re-arms follow", () => {
  const element = pane({ scrollHeight: 10_000, clientHeight: 500 });
  const { controller } = controllerFor(element);
  element.scrollTop = 4_000;
  controller.onScroll({ currentTarget: element } as unknown as Event);
  expect(controller.isFollowing()).toBe(false);
  element.scrollTop = element.scrollHeight - element.clientHeight;
  controller.onScroll({ currentTarget: element } as unknown as Event);
  expect(controller.isFollowing()).toBe(true);
});
