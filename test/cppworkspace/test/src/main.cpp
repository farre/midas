#include "testcase_namespaces/baseclasses.hpp"
#include "testcase_namespaces/derive.hpp"
#include "testcase_namespaces/enum.hpp"
#include "testcase_namespaces/longstack.hpp"
#include "testcase_namespaces/pp.hpp"
#include "testcase_namespaces/statics.hpp"
#include "testcase_namespaces/structrequests.hpp"
#include "testcase_namespaces/test_ptrs.hpp"
#include <iostream>
#include <iterator>
#include <number.hpp>
#include <string>
#include <vector>

// Singly linked list node mixin
template <typename T> struct intrusive_list_node { T *next = nullptr; };

int overload(int a) { return a * 2; }
float overload(float a) { return a * 2.0f; }
double overload(double a) { return a * 2.0; }

template <IsNumber Num> Number<Num> add_two(Num a, Num b) {
  Number l{a};
  Number r{b};
  return Number<Num>::sum(l, r);
}

struct S {
  int j;
  int k;
};

struct T : intrusive_list_node<T> {
  S s;
  float f;
};

struct Ts {
  T *ts;
};

void doFooBar() {
  S fooBar{.j = 10, .k = 100};
  fooBar.j += 1;
}

void testRValueReferences(std::string &&item) {
  auto result = item;
  std::cout << "item is: " << result;
}

// test case for inlined functions and breakpoints set on them.
inline void alter_t(T &t) {
  t.f++;
  t.s.j++;
  t.s.k++;
}

int main(int argc, const char **argv) {
  std::vector<std::string> foos[3]{};

  std::vector<std::string> captured_args;
  std::copy(argv, argv + argc, std::back_inserter(captured_args));
  std::copy(argv, argv + argc, std::back_inserter(foos[0]));
  std::copy(argv, argv + argc, std::back_inserter(foos[1]));
  std::copy(argv, argv + argc, std::back_inserter(foos[2]));
  std::string helloworld{"Hello world, I manage myself and I'm also made sure "
                         "to be allocated on the heap"};
  std::string_view v{helloworld};

  doFooBar();
  testRValueReferences(std::move(helloworld));
  T t{.s = S{.j = 10, .k = 200}, .f = 3.14};
  [[always_inline]] alter_t(t);
  std::vector<T> vec_ts{};
  vec_ts.push_back(T{.s = S{.j = 42, .k = 5005}, .f = 13.37});
  vec_ts.push_back(T{.s = S{.j = 1, .k = 2}, .f = 3.0});
  [[always_inline]] alter_t(t);
  // watch variable `stack_ts[0:2]` should produce 2 elements of T
  T stack_ts[2]{T{.s = S{.j = 42, .k = 5005}, .f = 13.37},
                T{.s = S{.j = 1, .k = 2}, .f = 3.0}};
  stack_ts[0].next = &stack_ts[1];
  auto tptrs = new T *[2];
  // watch variable `tptrs[0:2]` should produce 2 elements of T*
  tptrs[0] = vec_ts.data();
  tptrs[1] = vec_ts.data() + 1;
  // watch variable: `it[0:2]` should produce first two elements of vec_ts since
  // they are laid out adjacent in memory
  T *it = *tptrs;
  // for testing that watch var subscript operators work on members;
  // `ts.ts[0:2]` should produce what `it[0:2]` does in this case
  Ts ts;
  ts.ts = vec_ts.data();

  const auto somelocal = 42;
  constexpr int array[10] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9};
  constexpr S s_array[7]{{1, 2}, {2, 3}, {3, 4}, {4, 5},
                         {5, 6}, {6, 7}, {7, 8}};
  T *tptr_to_stack = stack_ts;

  T **ptrs_to_ptr = new T *[2];
  ptrs_to_ptr[0] = vec_ts.data();
  ptrs_to_ptr[1] = new T{.s = S{.j = 999, .k = 888}, .f = -0.1234567};
  ptrs_to_ptr[1]->next = &vec_ts.back();
  auto iptr = new int{42};
  int *ptrs[10];
  int *arrayPtrs = new int[10];
  for (auto idx = 0; idx < 10; idx++) {
    ptrs[idx] = new int{42 + idx};
    arrayPtrs[idx] = idx;
  }
  t.s.j++;

  // shadowing test
  int i = 10;
  {
    int i = 20;
    float f = 2.0f;
  }
  const auto j = i;

  i += 1;
  // set breakpoint here.
  auto Double = add_two(1.550795, 1.590795);
  auto Float = add_two(668.19685f, 668.93685f);
  auto Int = add_two(20, 22);

  int ol1 = overload(1);
  float ol2 = overload(2.0f);
  double ol3 = overload(3.0);

  // lets be longer than a machine register
  static const auto foo = "foobar is something to say";
  static constexpr auto bar = "saying barfoo is something nobody does";
  constexpr auto baz = "baz is also kind of a cool word!!!!!!!!!!!!!!!";
  constexpr const char *bazchar = "These types end up being wildly different";
  std::cout << "Goodbye cruel world" << std::endl;
  prettyprinting::main();
  test_ptrs_main();
  enum_stuff();
  derive::main();
  baseclasses::main();
  longstack::main();
  statics::main();
  structsrequests::main();
}
