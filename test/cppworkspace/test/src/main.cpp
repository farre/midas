#include <iostream>
#include <vector>
#include <string>
#include <number.hpp>
#include <todo.hpp>

int chain25(int v);
int chain24(int v);
int chain23(int v);
int chain22(int v);
int chain21(int v);
int chain20(int v);
int chain19(int v);
int chain18(int v);
int chain17(int v);
int chain16(int v);
int chain15(int v);
int chain14(int v);
int chain13(int v);
int chain12(int v);
int chain11(int v);
int chain10(int v);
int chain9(int v);
int chain8(int v);
int chain7(int v);
int chain6(int v);
int chain5(int v);
int chain4(int v);
int chain3(int v);
int chain2(int v);



int overload(int a) { 
  return a * 2; 
}
float overload(float a) { 
  return a * 2.0f; 
}
double overload(double a) { 
  return a * 2.0; 
}

template <IsNumber Num> Number<Num> add_two(Num a, Num b) {
  Number l{a};
  Number r{b};
  return Number<Num>::sum(l, r);
}

int chain25(int v) {
  int result = 24;
  result = v / -5;
  result += 5;
  return result;
}

int chain24(int v) {
  int result = 23;
  result = chain25(v * -5);
  result += 5;
  return result;
}

int chain23(int v) {
  int result = 22;
  result = chain24(v * -4);
  result += 5;
  return result;
}

int chain22(int v) {
  int result = 21;
  result = chain23(v * -3);
  result += 5;
  return result;
}

int chain21(int v) {
  int result = 20;
  result = chain22(v * -2);
  result += 5;
  return result;
}

int chain20(int v) {
  int result = 19;
  result = chain21(v * -1);
  result += 5;
  return result;
}

int chain19(int v) {
  int result = 18;
  result = chain20(v - 10);
  result += 5;
  return result;
}

int chain18(int v) {
  int result = 17;
  result = chain19(v - 9);
  result += 5;
  return result;
}

int chain17(int v) {
  int result = 16;
  result = chain18(v - 8);
  result += 5;
  return result;
}

int chain16(int v) {
  int result = 15;
  result = chain17(v - 7);
  result += 5;
  return result;
}

int chain15(int v) {
  int result = 14;
  result = chain16(v - 6);
  result += 5;
  return result;
}

int chain14(int v) {
  int result = 13;
  result = chain15(v - 5);
  result += 5;
  return result;
}

int chain13(int v) {
  int result = 12;
  result = chain14(v - 4);
  result += 5;
  return result;
}

int chain12(int v) {
  int result = 11;
  result = chain13(v - 3);
  result += 5;
  return result;
}

int chain11(int v) {
  int result = 10;
  result = chain12(v);
  result += 5;
  return result;
}

int chain10(int v) {
  int result = 9;
  result = chain11(v / 2);
  result += 5;
  return result;
}

int chain9(int v) {
  int result = 8;
  result = chain10(v / 3);
  result += 5;
  return result;
}

int chain8(int v) {
  int result = 7;
  result = chain9(v / 4);
  result += 5;
  return result;
}

int chain7(int v) {
  int result = 6;
  result = chain8(v / 5);
  result += 5;
  return result;
}

int chain6(int v) {
  int result = 5;
  result = chain7(v / 6);
  result += 5;
  return result;
}

int chain5(int v) {
  int result = 4;
  result = chain6(v * 6);
  result += 5;
  return result;
}

int chain4(int v) {
  int result = 3;
  result = chain5(v * 5);
  result += 4;
  return result;
}

int chain3(int v) {
  int result = 2;
  result = chain4(v * 4);
  result += 3;
  return result;
}

int chain2(int v) {
  int result = 1;
  result = chain3(v * 3);
  result += 2;
  return result;
}

int start_stackchain(int v) {
  int result = 0;
  result = chain2(v * 2);
  return result + 1;
}

void do_todo(Todo& t) {
  std::cout << t.title() << std::endl;
}

Todo move_todo(Todo&& t) {
  std::cout << t.title() << std::endl;
  return t;
}
static int ids = 0;
struct Base {
protected:
  int id;
  std::string name;
public:
  Base(int id, std::string name) : id(id), name(std::move(name)) {}
  virtual ~Base() {}

  virtual void sayHello() = 0;
};

struct Derived : Base {
  Derived(std::string sub_name) : Base(ids++, "Derived"), sub_name(std::move(sub_name)) {}
  ~Derived() = default;

  std::string sub_name;
  void sayHello() override {
    std::cout << "[ID: " << this->id << "]: Hello my name is: " << this->name << ", " << this->sub_name << std::endl;
  }
};

struct IntDerived : Base {
  IntDerived(int sub_id) : Base(ids++, "Derived"), sub_id(sub_id) {}
  virtual ~IntDerived() = default;
  int sub_id;
  void sayHello() override {
    std::cout << "[ID: " << this->id << ":" << this->sub_id << "]: Hello my name is: " << this->name << std::endl;
  }

  void foo() {
    std::cout << "[ID: " << this->id << ":" << this->sub_id << "]: Hello my name is: " << this->name << std::endl;
  }
};

struct Final : public IntDerived {
  int m_k;
  Final(int k, int sub) : IntDerived(sub), m_k(k) {

  }

  void sayHello() override {
    std::cout << "[ID: " << this->id << ":" << this->sub_id << "]: Hello my name is: " << this->name << " and I am derived of a derived. Value: " << m_k << std::endl;
  }
};

void take_interface(Base* b) {
  b->sayHello();
  std::cout << "good bye" << std::endl;
}

void two_impls() {
  Base* ba = new Derived{"foo"};
  IntDerived* bb = new IntDerived{42};
  bb->foo();
  take_interface(ba);
  take_interface(bb);
}

void testFinalDerived() {
  auto f = new Final{10, 1};
  f->sayHello();
  std::cout << "say hello, through interface" << std::endl;
  take_interface(f);
}

struct Struct {
  int i;
  float f;
  const char* name; 
};

struct Bar {
  int j = 0;
  Struct* s;
};



Struct variablesRequestTest(Struct s) {
  // set first breakpoint here
  const auto new_i = s.i + 10;
  const auto new_f = s.f + 10.10f;
  s.i = new_i;
  s.f = new_f;
  return s;
}

void variablesRequestTestReference(Struct& s) {
  const auto i = s.i + 10;
  const auto f = s.f + 10.10f;
  s.i = i;
  s.f = f;
}

int testSubChildUpdate(Bar* b) {
    b->j++;
    variablesRequestTestReference(*b->s);
    auto res = b->s->f;
    return res;
}

void variablesRequestTestPointer(Struct* s) {
  auto local_ptr = s;
  const auto i = local_ptr->i + 10;
  const auto f = local_ptr->f + 10.10f;
  variablesRequestTestReference(*s);
  local_ptr->i += i;
  local_ptr->f += f;
  variablesRequestTestReference(*s);
  local_ptr = nullptr;
}
static Todo static_todo = Todo{"Static Todo", Date{.day = 4, .month = 2, .year = 2022}};
static int oneIntStatic = 1337;
struct Big {
  static Todo* todo;
  static int* oneInt;
  Todo* myTodo;
  Number<double> dbl;
  Big(double da, double db) : myTodo(new Todo{"Pointer to Todo", Date{.day = 25, .month = 1, .year = 2022}}), dbl(add_two(da, db)) {

  }

  ~Big() {
    delete myTodo;
  }
};

Todo* Big::todo = &static_todo;
int* Big::oneInt = &oneIntStatic;

int main(int argc, const char **argv) {  
  auto big = new Big{1.550795, 1.590795};

  const auto somelocal = 42;
  constexpr int array[42] = {};
  Todo tmp{"Test local struct", Date{.day = 3, .month = 11, .year = 2021}};
  auto tmpptr = new Todo{"Pointer to Todo", Date{.day = 25, .month = 1, .year = 2022}};

  auto Double = add_two(1.550795, 1.590795);
  auto Float = add_two(668.19685f, 668.93685f);
  auto Int = add_two(20, 22);

  std::cout << "Value of " << Double << std::endl;
  std::cout << "Value of " << Float << std::endl;
  std::cout << "Value of " << Int << std::endl;

  int ol1 = overload(1);
  float ol2 = overload(2.0f);
  double ol3 = overload(3.0);

  std::vector<Todo> todos{};
  todos.push_back(Todo{"Make test app for debugger extension",
                       Date{.day = 3, .month = 11, .year = 2021}});
  todos.push_back(Todo{"Read code-debug & look for useful stuff",
                       Date{.day = 4, .month = 11, .year = 2021}});
  todos.push_back(Todo{"Read vscode-mock-debug & rip out things of use",
                       Date{.day = 5, .month = 11, .year = 2021}});

  std::cout << "Things to do: " << Todo::todo_count() << std::endl;
  for (const auto &t : todos) {
    std::cout << "\tTodo id " << t.id() << ": " << t.title() << " @" << t.date()
              << std::endl;
  }
  // lets be longer than a machine register
  static const auto foo = "foobar is something to say";
  static constexpr auto bar = "saying barfoo is something nobody does";
  constexpr auto baz = "baz is also kind of a cool word!!!!!!!!!!!!!!!";
  constexpr const char *bazchar = "These types end up being wildly different";
  std::cout << "Goodbye cruel world" << std::endl;

  auto r = start_stackchain(10);
  std::cout << "result of chain: " << r << std::endl;

  std::cout << tmpptr->title() << std::endl;
  std::cout << tmp.title() << std::endl;

  do_todo(*tmpptr);
  auto a = move_todo(std::move(tmp));
  std::cout << a.title() << std::endl;
  two_impls();

  auto somestruct = new Struct { .i = 10, .f = 10.10f, .name = "somestruct" };
  auto copied_somestruct = variablesRequestTest(*somestruct);
  variablesRequestTestPointer(&copied_somestruct);
  auto iptr = new int{42};
  
  auto barptr = new Bar{.j = 100, .s = new Struct { .i = 10, .f = 10.10f, .name = "somestruct_refByBar" }};
  testSubChildUpdate(barptr);
  testFinalDerived();
}
